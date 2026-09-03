export const Errors = {
    REQUEST_SQS: {
        code: "ERROR-01",
        message: "No records found in the event.",
    },
    DATABASE: {
        code: "ERROR-02",
        message: "There was an error with the dynamoDB.",
    },
    SSM: {
        code: "ERROR-03",
        message: "There was an error with the SSM.",
    },
    S3: {
        code: "ERROR-04",
        message: "There was an error with the S3.",
    },
    SQS: {
        code: "ERROR-05",
        message: "There was an error with the SQS.",
    },
    STEP_FUNCTION: {
        code: "ERROR-06",
        message: "There was an error with the Step Function.",
    },
    SECRET: {
        code: "ERROR-07",
        message: "There was an error with the Secret.",
    },
    SES: {
        code: "ERROR-08",
        message: "There was an error with SES services.",
    },
    SNS: {
        code: "ERROR-09",
        message: "There was an error with SNS services.",
    },
} as const;
