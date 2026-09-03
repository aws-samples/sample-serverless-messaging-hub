export interface ErrorType {
    code: string;
    httpCode: number;
    messages?: string[];
    message?: string[];
}

export class BusinessError extends Error {
    code: string;
    httpCode: number;
    messages?: string[];

    constructor(error: ErrorType) {
        super();
        Object.setPrototypeOf(this, BusinessError.prototype);
        Error.captureStackTrace(this, this.constructor);
        this.code = error.code;
        this.httpCode = error.httpCode;
        this.messages = error.messages ?? error.message ?? ['Generic error'];
    }
}
