import retry from 'async-retry'
import {Command} from 'clipanion'
import {BufferedMetricsLogger} from 'datadog-metrics'
import fs from 'fs'
import path from 'path'
import {getMetricsLogger} from '../../helpers/metrics'
import {getApiHostForSite} from '../../helpers/utils'

import {apiConstructor} from './api'
import {Payload} from './interfaces'
import {
  renderCannotFindFile,
  renderCommandInfo,
  renderDryRunUpload,
  renderFailedUpload,
  renderFailedUploadBecauseOf403,
  renderMissingEnvironmentVariable,
  renderMissingParameter,
  renderMissingReleaseVersionParameter,
  renderRetriedUpload,
  renderSuccessfulCommand,
  renderUnsupportedParameterValue,
  renderUpload,
} from './renderer'

const errorCodesNoRetry = [400, 403, 413]

export class UploadCommand extends Command {
  public static SUPPORTED_SOURCES = ['snyk']

  public static usage = Command.Usage({
    description: 'Upload dependencies graph to Datadog.',
    details:
      'Uploads dependencies graph to Datadog to detect runtime vulnerabilities by Continuous Profiler. See README for details.',
    examples: [
      [
        'Upload dependency graph generated by `snyk test --print-deps --sub-project=my-project --json > ./snyk_deps.json` command',
        'datadog-ci dependencies upload ./snyk_deps.json --source snyk --service my-service --release-version 1.234',
      ],
    ],
  })

  private static INVALID_INPUT_EXIT_CODE = 1
  private static MISSING_FILE_EXIT_CODE = 2
  private static UPLOAD_ERROR_EXIT_CODE = 3

  private config = {
    apiHost: getApiHostForSite(process.env.DATADOG_SITE || 'datadoghq.com'),
    apiKey: process.env.DATADOG_API_KEY,
    appKey: process.env.DATADOG_APP_KEY,
  }
  private dependenciesFilePath!: string
  private dryRun = false
  private releaseVersion?: string
  private service?: string
  private source?: string

  public async execute() {
    // Validate input
    if (!this.source) {
      this.context.stderr.write(renderMissingParameter('--source', UploadCommand.SUPPORTED_SOURCES))

      return UploadCommand.INVALID_INPUT_EXIT_CODE
    }
    if (UploadCommand.SUPPORTED_SOURCES.indexOf(this.source) === -1) {
      this.context.stderr.write(
        renderUnsupportedParameterValue('--source', this.source, UploadCommand.SUPPORTED_SOURCES)
      )

      return UploadCommand.INVALID_INPUT_EXIT_CODE
    }
    if (!this.service) {
      this.context.stderr.write(renderMissingParameter('--service'))

      return UploadCommand.INVALID_INPUT_EXIT_CODE
    }
    if (!this.config.appKey) {
      this.context.stderr.write(renderMissingEnvironmentVariable('DATADOG_APP_KEY'))

      return UploadCommand.INVALID_INPUT_EXIT_CODE
    }
    if (!this.config.apiKey) {
      this.context.stderr.write(renderMissingEnvironmentVariable('DATADOG_API_KEY'))

      return UploadCommand.INVALID_INPUT_EXIT_CODE
    }

    // Display warning for missing --release-version
    if (!this.releaseVersion) {
      this.context.stdout.write(renderMissingReleaseVersionParameter())
    }

    // Check if file exists (we are not validating the content of the file)
    this.dependenciesFilePath = path.resolve(this.dependenciesFilePath)
    if (!fs.existsSync(this.dependenciesFilePath)) {
      this.context.stderr.write(renderCannotFindFile(this.dependenciesFilePath))

      return UploadCommand.MISSING_FILE_EXIT_CODE
    }

    const defaultTags = [`service:${this.service}`]
    if (this.releaseVersion) {
      defaultTags.push(`version:${this.releaseVersion}`)
    }
    const metricsLogger = getMetricsLogger({
      datadogSite: process.env.DATADOG_SITE,
      defaultTags,
      prefix: 'datadog.ci.dependencies.',
    })

    // Upload dependencies
    this.context.stdout.write(
      renderCommandInfo(this.dependenciesFilePath!, this.source, this.service, this.releaseVersion, this.dryRun)
    )

    try {
      const initialTime = Date.now()
      const payload: Payload = {
        dependenciesFilePath: this.dependenciesFilePath,
        service: this.service,
        source: this.source,
        version: this.releaseVersion,
      }
      await this.uploadDependencies(payload, metricsLogger.logger)
      const totalTimeSeconds = (Date.now() - initialTime) / 1000

      this.context.stdout.write(renderSuccessfulCommand(totalTimeSeconds))

      metricsLogger.logger.gauge('duration', totalTimeSeconds)
    } catch (error) {
      this.context.stderr.write(`${error.message}\n`)

      return UploadCommand.UPLOAD_ERROR_EXIT_CODE
    } finally {
      try {
        await metricsLogger.flush()
      } catch (err) {
        this.context.stdout.write(`WARN: ${err}\n`)
      }
    }
  }

  private async uploadDependencies(payload: Payload, metricsLogger: BufferedMetricsLogger) {
    const api = apiConstructor(`https://${this.config.apiHost}`, this.config.apiKey!, this.config.appKey!)

    try {
      await retry(
        async (bail) => {
          try {
            if (this.dryRun) {
              this.context.stdout.write(renderDryRunUpload())

              return
            }

            this.context.stdout.write(renderUpload())
            await api.uploadDependencies(payload)
            metricsLogger.increment('success', 1)
          } catch (error) {
            if (error.response && !errorCodesNoRetry.includes(error.response.status)) {
              // If it's an axios error and a status code that is not excluded from retries,
              // throw the error so that upload is retried
              throw error
            }
            // If it's another error or an axios error we don't want to retry, bail
            bail(error)

            return
          }
        },
        {
          onRetry: (error, attempt) => {
            metricsLogger.increment('retries', 1)
            this.context.stdout.write(renderRetriedUpload(error.message, attempt))
          },
          retries: 5,
        }
      )
    } catch (error) {
      if (error.response && error.response.status === 403) {
        this.context.stdout.write(renderFailedUploadBecauseOf403(error.message))
      } else {
        this.context.stdout.write(renderFailedUpload(error.message))
      }
      metricsLogger.increment('failed', 1)

      throw error
    }
  }
}

UploadCommand.addPath('dependencies', 'upload')
UploadCommand.addOption('dependenciesFilePath', Command.String({required: true}))
UploadCommand.addOption('source', Command.String('--source'))
UploadCommand.addOption('releaseVersion', Command.String('--release-version'))
UploadCommand.addOption('service', Command.String('--service'))
UploadCommand.addOption('dryRun', Command.Boolean('--dry-run'))
