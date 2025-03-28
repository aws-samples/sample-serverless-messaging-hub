import {SSMClient, GetParameterCommand} from "@aws-sdk/client-ssm";

export interface SSMGetParameterInput {
    Name: string;
}

export async function getParameterValue(parameterName: string): Promise<string | undefined> {
    const client = new SSMClient({region: process.env.AWS_REGION});

    try {
        const input: SSMGetParameterInput = {
            Name: parameterName
        };

        const command = new GetParameterCommand(input);
        const response = await client.send(command);

        return response.Parameter?.Value;
    } catch (error) {
        console.error('Error retrieving parameter:', error);
        throw error;
    }
}