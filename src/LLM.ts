import * as vscode from 'vscode';
import { hexlogger } from './extension';

export class LLM {
    private vendor: string;
    private model: string;
    private config: vscode.WorkspaceConfiguration;
    private apiKey: string|undefined;
    
    private openai: any;
    private googlecloud: any;

    

    constructor(modelString: string) {
        const { vendor, model } = this.getVendorModelFromModelString(modelString);
        this.vendor = vendor;
        this.model = model;
        this.config = vscode.workspace.getConfiguration('hex');
        vscode.window.showInformationMessage(`Using ${vendor} model ${model}`);
    }

    private getVendorModelFromModelString(modelString: string): { vendor: string, model: string } {
        // split the model name at the first space and return the vendor part
        const vendor = modelString.match(/^\[(.*?)\]/)?.[1] ?? ''; // extract vendor or fallback to empty string
        const model = modelString.replace(/^\[.*?\]\s*/, ''); // remove vendor part
        return { vendor, model };
    }

    private async loadAndInitSDK(vendor: string): Promise<any> {
        // loads the right vendor sdk
        let sdk;
        switch (vendor) {
            case 'OpenAI':
                sdk = await import('openai'); // dynamically import the OpenAI SDK
                this.apiKey = this.config.get<string>('OpenAIApiKey') ?? 
                    ( () => { throw new Error('OpenAI model selected but API Key is not defined.'); })();
                this.openai = new sdk.OpenAI({apiKey: this.apiKey});
                break;
            //case 'Google':
            //    sdk = await import('@google-cloud/ai-platform'); // dynamically import Google AI SDK
            //    break;
            default:
                hexlogger.log(`Unsupported vendor: ${vendor}`);
                vscode.window.showErrorMessage(`Unsupported vendor: ${vendor}`);
                throw new Error(`Unsupported vendor: ${vendor}`);
        }
    }

    public async initialize() {
        await this.loadAndInitSDK(this.vendor);
    }

    public async chatCompletion(messages: [any], tools: [any], tool_choice: any, signal: AbortSignal, llm_options: Record<string, any> ) {
        try {
            switch (this.vendor) {
                case 'OpenAI':
                    const response = await this.openai.chat.completions.create(
                        {
                            model: this.model,
                            messages: messages,
                            tools: tools,
                            //tool_choice: {"type": "function", "function": {"name": "replace_code"}},
                            tool_choice: tool_choice,
                            ...llm_options
                        },
                        {
                            signal: signal,
                        }
                    );
                    const functionArgs = JSON.parse(response.choices[0].message.tool_calls[0].function.arguments);
                    if(functionArgs) {
                        hexlogger.log("Function args detected");
                        //hexlogger.log(JSON.stringify(functionArgs, null, 2));
                        return functionArgs;
                    }
                    return response;
                default:
                    vscode.window.showErrorMessage(`Unsupported vendor: ${this.vendor}`);
                    throw new Error(`Unsupported vendor: ${this.vendor}`);
            }
        }
        catch (error: unknown) {
            const errorMessage = (error instanceof Error) ? error.message : `An unknown error occurred: ${error}`;
            hexlogger.log(`Error in chatCompletion: ${errorMessage}`);
            vscode.window.showErrorMessage(`Error during API call: ${errorMessage}`);
            throw error;
        }
    }

}