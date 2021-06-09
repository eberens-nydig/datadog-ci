import chalk from 'chalk'
import {Command} from 'clipanion'

import {parseConfigFile, ProxyConfiguration} from '../../helpers/utils'
import {apiConstructor} from './api'
import {
  APIHelper,
  ConfigOverride,
  ExecutionRule,
  LocationsMapping,
  MainReporter,
  PollResult,
  Reporter,
  Test,
  TriggerConfig,
} from './interfaces'
import {DefaultReporter} from './reporters/default'
import {JUnitReporter} from './reporters/junit'
import {Tunnel} from './tunnel'
import {getReporter, getSuites, getTestsToTrigger, hasTestSucceeded, runTests, waitForResults} from './utils'

export class RunTestCommand extends Command {
  private apiKey?: string
  private appKey?: string
  private config = {
    apiKey: process.env.DATADOG_API_KEY,
    appKey: process.env.DATADOG_APP_KEY,
    datadogSite: process.env.DATADOG_SITE || 'datadoghq.com',
    files: '{,!(node_modules)/**/}*.synthetics.json',
    global: {} as ConfigOverride,
    pollingTimeout: 2 * 60 * 1000,
    proxy: {protocol: 'http'} as ProxyConfiguration,
    subdomain: process.env.DATADOG_SUBDOMAIN || 'app',
    tunnel: false,
  }
  private configPath?: string
  private fileGlobs?: string[]
  public jUnitReport?: string
  private publicIds: string[] = []
  private reporter?: MainReporter
  public runName?: string
  private shouldOpenTunnel?: boolean
  private testSearchQuery?: string

  public async execute() {
    const reporters: Reporter[] = [new DefaultReporter(this)]

    if (this.jUnitReport) {
      reporters.push(new JUnitReporter(this))
    }

    this.reporter = getReporter(reporters)
    const startTime = Date.now()
    this.config = await parseConfigFile(this.config, this.configPath)

    const api = this.getApiHelper()
    const publicIdsFromCli = this.publicIds.map((id) => ({suite: 'CLI Suite', config: this.config.global, id}))
    const testsToTrigger = publicIdsFromCli.length ? publicIdsFromCli : await this.getTestsList(api)

    if (!testsToTrigger.length) {
      this.reporter.log('No test suites to run.\n')

      return 0
    }

    const {tests, overriddenTestsToTrigger, summary} = await getTestsToTrigger(api, testsToTrigger, this.reporter)
    const publicIdsToTrigger = tests.map(({public_id}) => public_id)

    let tunnel: Tunnel | undefined
    if ((this.shouldOpenTunnel === undefined && this.config.tunnel) || this.shouldOpenTunnel) {
      this.reporter.log(
        'You are using tunnel option, the chosen location(s) will be overridden by a location in your account region.\n'
      )
      // Get the pre-signed URL to connect to the tunnel service
      const {url: presignedURL} = await api.getPresignedURL(publicIdsToTrigger)
      // Open a tunnel to Datadog
      try {
        tunnel = new Tunnel(presignedURL, publicIdsToTrigger, this.config.proxy, this.reporter)
        const tunnelInfo = await tunnel.start()
        overriddenTestsToTrigger.forEach((testToTrigger) => {
          testToTrigger.tunnel = tunnelInfo
        })
      } catch (e) {
        this.reporter.error(`\n${chalk.bgRed.bold(' ERROR on tunnel start ')}\n${e.stack}\n\n`)

        return 1
      }
    }
    const triggers = await runTests(api, overriddenTestsToTrigger)

    // All tests have been skipped or are missing.
    if (!tests.length) {
      this.reporter.log('No test to run.\n')

      return 0
    }

    if (!triggers.results) {
      throw new Error('No result to poll.')
    }

    try {
      // Poll the results.
      const results = await waitForResults(api, triggers.results, this.config.pollingTimeout, testsToTrigger, tunnel)

      // Sort tests to show success first then non blocking failures and finally blocking failures.
      tests.sort(this.sortTestsByOutcome(results))

      // Rendering the results.
      this.reporter.reportStart({startTime})
      const locationNames = triggers.locations.reduce((mapping, location) => {
        mapping[location.id] = location.display_name

        return mapping
      }, {} as LocationsMapping)

      let hasSucceeded = true // Determine if all the tests have succeeded
      for (const test of tests) {
        const testResults = results[test.public_id]

        const passed = hasTestSucceeded(testResults)
        if (passed) {
          summary.passed++
        } else {
          summary.failed++
          if (test.options.ci?.executionRule !== ExecutionRule.NON_BLOCKING) {
            hasSucceeded = false
          }
        }

        this.reporter.testEnd(test, testResults, this.getAppBaseURL(), locationNames)
      }

      this.reporter.runEnd(summary)

      if (hasSucceeded) {
        return 0
      } else {
        return 1
      }
    } catch (error) {
      this.reporter.error(`\n${chalk.bgRed.bold(' ERROR ')}\n${error.stack}\n\n`)

      return 1
    } finally {
      // Stop the tunnel
      if (tunnel) {
        await tunnel.stop()
      }
    }
  }

  private getApiHelper() {
    this.config.apiKey = this.apiKey || this.config.apiKey
    this.config.appKey = this.appKey || this.config.appKey

    if (!this.config.appKey || !this.config.apiKey) {
      if (!this.config.appKey) {
        this.reporter!.error(`Missing ${chalk.red.bold('DATADOG_APP_KEY')} in your environment.\n`)
      }
      if (!this.config.apiKey) {
        this.reporter!.error(`Missing ${chalk.red.bold('DATADOG_API_KEY')} in your environment.\n`)
      }
      throw new Error('API and/or Application keys are missing')
    }

    return apiConstructor({
      apiKey: this.config.apiKey!,
      appKey: this.config.appKey!,
      baseIntakeUrl: this.getDatadogHost(true),
      baseUrl: this.getDatadogHost(),
      proxyOpts: this.config.proxy,
    })
  }

  private getAppBaseURL() {
    return `https://${this.config.subdomain}.${this.config.datadogSite}/`
  }

  private getDatadogHost(useIntake = false) {
    const apiPath = 'api/v1'
    let host = `https://api.${this.config.datadogSite}`
    const hostOverride = process.env.DD_API_HOST_OVERRIDE

    if (hostOverride) {
      host = hostOverride
    } else if (
      useIntake &&
      (this.config.datadogSite === 'datadoghq.com' || this.config.datadogSite === 'datad0g.com')
    ) {
      host = `https://intake.synthetics.${this.config.datadogSite}`
    }

    return `${host}/${apiPath}`
  }

  private async getTestsList(api: APIHelper): Promise<TriggerConfig[]> {
    if (this.testSearchQuery) {
      const testSearchResults = await api.searchTests(this.testSearchQuery)

      return testSearchResults.tests.map((test) => ({
        config: this.config.global,
        id: test.public_id,
        suite: `Query: ${this.testSearchQuery}`,
      }))
    }

    const listOfGlobs = this.fileGlobs || [this.config.files]

    const suites = (await Promise.all(listOfGlobs.map((glob: string) => getSuites(glob, this.reporter!))))
      .reduce((acc, val) => acc.concat(val), [])
      .filter((suite) => !!suite.content.tests)

    const testsToTrigger = suites
      .map((suite) => {
        return suite.content.tests.map((test) => ({
          suite: suite.name,
          config: {...this.config!.global, ...test.config},
          id: test.id,
        }))
      })
      .reduce((acc, suiteTests) => acc.concat(suiteTests), [])
    return testsToTrigger
  }

  private sortTestsByOutcome(results: {[key: string]: PollResult[]}) {
    return (t1: Test, t2: Test) => {
      const success1 = hasTestSucceeded(results[t1.public_id])
      const success2 = hasTestSucceeded(results[t2.public_id])
      const isNonBlockingTest1 = t1.options.ci?.executionRule === ExecutionRule.NON_BLOCKING
      const isNonBlockingTest2 = t2.options.ci?.executionRule === ExecutionRule.NON_BLOCKING

      if (success1 === success2) {
        if (isNonBlockingTest1 === isNonBlockingTest2) {
          return 0
        }

        return isNonBlockingTest1 ? -1 : 1
      }

      return success1 ? -1 : 1
    }
  }
}

/* {
  "suite": "javascript/datadog/single-page-app/lib/search-panel/search-panel.synthetics.json",
  "status": "live",
  "public_id": "fgt-ki8-5st",
  "tags": [
    "env:ci",
    "env:prod",
    "team:designops"
  ],
  "locations": [
    "aws:eu-central-1"
  ],
  "message": "",
  "name": "[Cmd+K] Clicks and enters",
  "monitor_id": 30577295,
  "type": "browser",
  "config": {
    "variables": [],
    "setCookie": "",
    "request": {
      "url": "https://app.datadoghq.com",
      "headers": {},
      "method": "GET"
    },
    "assertions": []
  },
  "options": {
    "ci": {
      "executionRule": "blocking"
    },
    "retry": {
      "count": 0,
      "interval": 300
    },
    "min_location_failed": 1,
    "min_failure_duration": 0,
    "noScreenshot": false,
    "tick_every": 3600,
    "forwardProxy": false,
    "device_ids": [
      "chrome.laptop_large"
    ],
    "monitor_options": {
      "renotify_interval": 0
    },
    "ignoreServerCertificateError": false
  }
} */

;[
  {
    config_override: {
      public_id: 'acj-mif-h4p',
      executionRule: 'non_blocking',
      startUrl: 'https://app-aedcbe9f6948b970a1e3b90ce530c471.datadoghq.com/',
    },
    check_id: '891777',
    timestamp: 1622814219790,
    check_version: 12,
    resultID: '5514243239262121697',
    orgID: 2,
    result: {
      runType: 2,
      artifactsBucketKey:
        '2/e2e-tests/acj-mif-h4p/results/5514243239262121697/chrome.laptop_large/artifacts__1622814304876.json',
      browserType: 'chrome',
      eventType: 'finished',
      errorMessage: 'Custom assertion returned a falsy value.',
      browserVersion: '91.0.4472.77',
      mainDC: 'us1.prod',
      timeToInteractive: 2205.0999999940395,
      errorCode: 'ASSERTION_FAILURE',
      failure: {
        message: 'Custom assertion returned a falsy value.',
        code: 'ASSERTION_FAILURE',
      },
      device: {
        name: 'Laptop Large',
        height: 1100,
        width: 1440,
        userAgent:
          'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.77 Safari/537.36',
        id: 'chrome.laptop_large',
        isMobile: false,
        browser: 'chrome',
      },
      stepDetails: [
        {
          browserErrors: [],
          vitalsMetrics: [
            {
              url: 'https://app-aedcbe9f6948b970a1e3b90ce530c471.datadoghq.com/account/login?next=%2F',
              lcp: 2241.599,
              cls: 0.1,
            },
          ],
          skipped: false,
          description: 'Navigate to start URL',
          warnings: [
            {
              message: 'None or multiple elements detected: .single-page-app_layout_trial-top-bar',
              type: 'user_locator',
            },
          ],
          url: 'about:blank',
          value: 'https://app-aedcbe9f6948b970a1e3b90ce530c471.datadoghq.com/',
          duration: 3001,
          allowFailure: false,
          screenshotBucketKey:
            '2/e2e-tests/acj-mif-h4p/results/5514243239262121697/chrome.laptop_large/step-0__1622814304889.jpeg',
          type: 'goToUrlAndMeasureTti',
          stepId: -1,
        },
        {
          subTestStepDetails: [
            {
              browserErrors: [],
              vitalsMetrics: [],
              skipped: false,
              publicId: 'cn7-qc3-dx4',
              description: 'Type text on input #username',
              url: 'https://app-aedcbe9f6948b970a1e3b90ce530c471.datadoghq.com/account/login?next=%2F',
              value: 'nadir.kadem+infinitetrial@gmail.com',
              duration: 1650,
              allowFailure: false,
              screenshotBucketKey:
                '2/e2e-tests/acj-mif-h4p/results/5514243239262121697/chrome.laptop_large/step-1.0__1622814305386.jpeg',
              type: 'typeText',
              stepId: 2301407,
            },
            {
              browserErrors: [],
              vitalsMetrics: [],
              skipped: false,
              publicId: 'rci-hhn-td9',
              description: 'Type text on input #password',
              url: 'https://app-aedcbe9f6948b970a1e3b90ce530c471.datadoghq.com/account/login?next=%2F',
              value: '{{ TRIAL_ORG_BROWSER_TEST_PASSWORD }}',
              duration: 1346,
              allowFailure: false,
              screenshotBucketKey:
                '2/e2e-tests/acj-mif-h4p/results/5514243239262121697/chrome.laptop_large/step-1.1__1622814305877.jpeg',
              type: 'typeText',
              stepId: 2301408,
            },
            {
              browserErrors: [
                {
                  type: 'js',
                  description: 'DD.ThirdPartyApps: intercom could not identify().',
                  name: 'Console error',
                },
                {
                  type: 'js',
                  description:
                    'React-Hot-Loader: misconfiguration detected, using production version in non-production environment.',
                  name: 'Console error',
                },
                {
                  type: 'js',
                  description: 'React-Hot-Loader: Hot Module Replacement is not enabled.',
                  name: 'Console error',
                },
              ],
              vitalsMetrics: [
                {
                  url: 'https://app-aedcbe9f6948b970a1e3b90ce530c471.datadoghq.com/help/quick_start',
                  lcp: 5049.4,
                  cls: 0.026,
                },
              ],
              skipped: false,
              publicId: 'wfi-cxb-4hj',
              description: 'Click on button "Log in"',
              url: 'https://app-aedcbe9f6948b970a1e3b90ce530c471.datadoghq.com/account/login?next=%2F',
              duration: 5643,
              allowFailure: false,
              screenshotBucketKey:
                '2/e2e-tests/acj-mif-h4p/results/5514243239262121697/chrome.laptop_large/step-1.2__1622814306426.jpeg',
              type: 'click',
              stepId: 2301409,
            },
          ],
          skipped: false,
          publicId: '4m7-x72-rx2',
          description: '[CI] Trial Org Login',
          url: 'https://app-aedcbe9f6948b970a1e3b90ce530c471.datadoghq.com/account/login?next=%2F',
          allowFailure: false,
          duration: 8639,
          type: 'playSubTest',
          subTestPublicId: 'cwu-4xc-maj',
          stepId: 2301796,
          playingTab: -1,
        },
        {
          browserErrors: [
            {
              type: 'js',
              description: 'DD.ThirdPartyApps: intercom could not identify().',
              name: 'Console error',
            },
            {
              type: 'js',
              description:
                'React-Hot-Loader: misconfiguration detected, using production version in non-production environment.',
              name: 'Console error',
            },
            {
              type: 'js',
              description: 'React-Hot-Loader: Hot Module Replacement is not enabled.',
              name: 'Console error',
            },
            {
              type: 'js',
              description:
                'Warning: validateDOMNesting(...): %s cannot appear as a descendant of <%s>.%s, <ul>, p, \n    in ul (created by Text)\n    in Text (created by List)\n    in List (created by Tutorial)\n    in p (created by Text)\n    in Text (created by Paragraph)\n    in Paragraph (created by TutorialStep)\n    in div (created by Flex)\n    in Flex (created by TutorialStep)\n    in TutorialStep (created by Tutorial)\n    in div (created by ProductOverview)\n    in div (created by ProductOverview)\n    in ProductOverview (c',
              name: 'Console error',
            },
          ],
          vitalsMetrics: [
            {
              url: 'https://app-aedcbe9f6948b970a1e3b90ce530c471.datadoghq.com/apm/intro',
              lcp: 3051.099,
              cls: 0.026,
            },
          ],
          skipped: false,
          publicId: 'yfu-ch5-ciy',
          description: 'Navigate to link',
          url: 'https://app-aedcbe9f6948b970a1e3b90ce530c471.datadoghq.com/help/quick_start',
          value: '/apm/intro',
          duration: 3341,
          allowFailure: false,
          screenshotBucketKey:
            '2/e2e-tests/acj-mif-h4p/results/5514243239262121697/chrome.laptop_large/step-2__1622814306975.jpeg',
          type: 'goToUrl',
          stepId: 2302967,
        },
        {
          browserErrors: [],
          vitalsMetrics: [],
          skipped: false,
          publicId: 'a57-py5-vt3',
          description: 'Wait',
          url: 'https://app-aedcbe9f6948b970a1e3b90ce530c471.datadoghq.com/apm/intro',
          value: 3,
          duration: 3000,
          allowFailure: false,
          screenshotBucketKey:
            '2/e2e-tests/acj-mif-h4p/results/5514243239262121697/chrome.laptop_large/step-3__1622814307760.jpeg',
          type: 'wait',
          stepId: 2303114,
        },
        {
          browserErrors: [],
          vitalsMetrics: [],
          skipped: false,
          publicId: 'k4d-h8j-dfu',
          description: 'Test that trial bar is here',
          url: 'https://app-aedcbe9f6948b970a1e3b90ce530c471.datadoghq.com/apm/intro',
          duration: 213,
          allowFailure: false,
          screenshotBucketKey:
            '2/e2e-tests/acj-mif-h4p/results/5514243239262121697/chrome.laptop_large/step-4__1622814308324.jpeg',
          type: 'assertElementPresent',
          stepId: 2301797,
        },
        {
          browserErrors: [],
          vitalsMetrics: [],
          skipped: true,
          publicId: 'yz5-4zu-2tf',
          description: 'Test that zendesk button is here in us office hours',
          url: 'https://app-aedcbe9f6948b970a1e3b90ce530c471.datadoghq.com/apm/intro',
          snapshotBucketKey:
            '2/e2e-tests/acj-mif-h4p/results/5514243239262121697/chrome.laptop_large/step-5__1622814308924.mhtml',
          duration: 59999,
          allowFailure: false,
          error: 'Error: Custom assertion returned a falsy value.',
          screenshotBucketKey:
            '2/e2e-tests/acj-mif-h4p/results/5514243239262121697/chrome.laptop_large/step-5__1622814308924.jpeg',
          type: 'assertFromJavascript',
          stepId: 2302507,
        },
      ],
      passed: false,
      error: 'Custom assertion returned a falsy value.',
      duration: 78193,
      startUrl: 'https://app-aedcbe9f6948b970a1e3b90ce530c471.datadoghq.com/',
    },
    dc_id: 32153,
    check: {
      type: 'browser',
      config: {
        variables: [],
        request: {
          url: 'https://app-aedcbe9f6948b970a1e3b90ce530c471.datadoghq.com/',
          headers: {},
          method: 'GET',
          timeout: 0,
        },
        assertions: [],
      },
      options: {
        ci: {
          executionRule: 'non_blocking',
        },
        retry: {
          count: 0,
          interval: 300,
        },
        min_location_failed: 1,
        monitor_options: {
          renotify_interval: 0,
        },
        tick_every: 3600,
        device_ids: ['chrome.laptop_large'],
        min_failure_duration: 0,
        ignoreServerCertificateError: true,
      },
      subtype: null,
    },
  },
]

RunTestCommand.addPath('synthetics', 'run-tests')
RunTestCommand.addOption('apiKey', Command.String('--apiKey'))
RunTestCommand.addOption('appKey', Command.String('--appKey'))
RunTestCommand.addOption('configPath', Command.String('--config'))
RunTestCommand.addOption('publicIds', Command.Array('-p,--public-id'))
RunTestCommand.addOption('testSearchQuery', Command.String('-s,--search'))
RunTestCommand.addOption('shouldOpenTunnel', Command.Boolean('-t,--tunnel'))
RunTestCommand.addOption('fileGlobs', Command.Array('-f,--files'))
RunTestCommand.addOption('jUnitReport', Command.String('-j,--junitReport'))
RunTestCommand.addOption('runName', Command.String('-n,--runName'))
