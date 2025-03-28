export type StatusType = {
    [key in
        | 'OK'
        | 'CREATED'
        | 'NO_CONTENT'
        | 'BAD_REQUEST'
        | 'UNAUTHORIZED'
        | 'FORBIDDEN'
        | 'NOT_FOUND'
        | 'CONFLICT'
        | 'UNPROCESSABLE_ENTITY'
        | 'INTERNAL_SERVER_ERROR'
        | 'BAD_GATEWAY'
        | 'GATEWAY_TIMEOUT']: StatusBodyType;
};

export type StatusBodyType = {
    httpCode: number;
    description: string;
};

export const HTTP_CONSTANT: StatusType = {
    OK: {
        httpCode: 200,
        description: 'OK',
    },
    CREATED: {
        httpCode: 201,
        description: 'CREATED',
    },
    NO_CONTENT: {
        httpCode: 204,
        description: 'NO CONTENT',
    },
    BAD_REQUEST: {
        httpCode: 400,
        description: 'BAD REQUEST',
    },
    UNAUTHORIZED: {
        httpCode: 401,
        description: 'UNAUTHORIZED',
    },
    FORBIDDEN: {
        httpCode: 403,
        description: 'FORBIDDEN',
    },
    NOT_FOUND: {
        httpCode: 404,
        description: 'NOT FOUND',
    },
    CONFLICT: {
        httpCode: 409,
        description: 'CONFLICT',
    },
    UNPROCESSABLE_ENTITY: {
        httpCode: 422,
        description: 'UNPROCESSABLE ENTITY',
    },
    INTERNAL_SERVER_ERROR: {
        httpCode: 500,
        description: 'INTERNAL SERVER ERROR',
    },
    BAD_GATEWAY: {
        httpCode: 502,
        description: 'BAD GATEWAY',
    },
    GATEWAY_TIMEOUT: {
        httpCode: 504,
        description: 'GATEWAY TIMEOUT',
    },
} as const;

export const METHODS = {
    GET: 'GET',
    POST: 'POST',
    PUT: 'PUT',
    DELETE: 'DELETE',
    PATCH: 'PATCH',
};
