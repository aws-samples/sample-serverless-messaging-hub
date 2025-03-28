export const CONSTANTS = {
  APP_NAME: 'serverless',
  APP_MODULE_KEY: 'project',
  APP_ORGANIZATION: 'aws',
  APP_ENVIRONMENT: {
    SANDBOX: 'sandbox',
    DEV: 'dev',
    QA: 'qa',
    UAT: 'uat',
    PROD: 'prod'
  },
  ENVIRONMENTS: [
    'sandbox', 'dev', 'qa', 'prod'
  ],
  TAG_POLICIES: {
    KEY_NAMES: {
      PRODUCT: 'Product',
      OWNER: 'Owner',
      ENVIRONMENT: 'Environment'
    },
    KEY_VALUES: {
      PRODUCT: {
        INFRASTRUCTURE: 'Infrastructure',
      },
      OWNER: {
        CLOUD_TEAM: 'CloudTeam'
      }
    }
  }
};
