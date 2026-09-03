import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';

const ssmClient = new SSMClient({});

/**
 * Retrieves a parameter value from AWS SSM Parameter Store.
 * Used at synth time to resolve the AWS account ID.
 */
export async function getParameterValue(parameterName: string): Promise<string> {
    const command = new GetParameterCommand({
        Name: parameterName,
    });
    const response = await ssmClient.send(command);
    if (!response.Parameter?.Value) {
        throw new Error(`SSM parameter "${parameterName}" not found or has no value`);
    }
    return response.Parameter.Value;
}
