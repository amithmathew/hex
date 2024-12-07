import * as vscode from 'vscode';
import { hexlogger } from './extension';
import { getVendorModelFromModelString } from './helpers';

export class LLM {
    public vendor: string;
    public model: string;
    private config: vscode.WorkspaceConfiguration;
    private apiKey: string|undefined;
    private tools: any;
    
    private openai: any;
    private googleai: any;

    

    constructor(modelString: string) {
        const { vendor, model } = getVendorModelFromModelString(modelString);
        this.vendor = vendor;
        this.model = model;
        this.config = vscode.workspace.getConfiguration('hex');
        vscode.window.showInformationMessage(`Using ${vendor} model ${model}`);
    }

    private async loadAndInitSDK(vendor: string): Promise<any> {
        // loads the right vendor sdk
        let sdk;
        switch (vendor) {
            case 'OpenAI':
                sdk = await import('openai'); // dynamically import the OpenAI SDK
                this.apiKey = this.config.get<string>('OpenaiApiKey') ?? 
                    ( () => { throw new Error('OpenAI model selected but API Key is not defined.'); })();
                this.openai = new sdk.OpenAI({apiKey: this.apiKey});
                break;
            case 'Google for Developers':
                sdk = await import('@google/generative-ai'); // dynamically import Google AI SDK
                this.apiKey = this.config.get<string>('GoogleCloudApiKey') ??
                    ( () => { throw new Error('Google AI for Developers model selected by API Key is not defined.'); }) ();
                let genAI = new sdk.GoogleGenerativeAI(this.apiKey);
                this.googleai = genAI.getGenerativeModel({model: this.model, tools: this.tools.Google});
                break;
            default:
                hexlogger.log(`Unsupported vendor: ${vendor}`);
                vscode.window.showErrorMessage(`Unsupported vendor: ${vendor}`);
                throw new Error(`Unsupported vendor: ${vendor}`);
        }
    }

    public async initialize(tools: any) {
        this.tools = tools;
        await this.loadAndInitSDK(this.vendor);
    }

    private buildMessages(messages: any) {
        var vendor_messages;
        switch (this.vendor) {
            case 'OpenAI':
                vendor_messages = messages.map((message: { role: any; content: any; }) => ({
                    role: message.role,
                    content: Array.isArray(message.content) ? message.content.map(c => ({
                        type: c.type,
                        [c.type]: c.data
                    })) : message.content
                }));
                hexlogger.log("OpenAI Messages: ");
                hexlogger.log(vendor_messages);
                return vendor_messages
            case 'Google for Developers':
                vendor_messages = messages.map((message: { user: any; content: any; }) => ({
                    role: message.user,
                    parts: Array.isArray(message.content) ? message.content.map(c => ({
                        text: c.text
                    })) : message.content
                }));
                hexlogger.log("Google for Developers Messages: ");
                hexlogger.log(vendor_messages);
            default:
                hexlogger.log(`Unknown vendor ${this.vendor}. Cannot reformat messages.`);
                throw new Error(`Unsupported vendor: ${this.vendor}`);
        }
    }

    public async chatCompletion(messages: [any], signal: AbortSignal, llm_options: Record<string, any> ) {
        try {
            let response;
            let vendor_messages = this.buildMessages(messages);
            switch (this.vendor) {
                case 'OpenAI':
                    response = await this.openai.chat.completions.create(
                        {
                            model: this.model,
                            messages: vendor_messages,
                            tools: this.tools.OpenAI,
                            //tool_choice: {"type": "function", "function": {"name": "replace_code"}},
                            tool_choice: "required",
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
                case 'Google for Developers':
                    response = await this.googleai.generateContent(
                        {
                            contents: vendor_messages,
                            tools: this.tools.Google,
                            tool_config: {
                                function_calling_config: {
                                    mode: 'ANY',
                                    allowed_function_names: this.tools.Google.functionDeclarations.map((declaration: { name: any; }) => declaration.name)// Extracting the names under Google as a list       
                                }
                            }

                        }
                    );
                    hexlogger.log("RECEIVED GOOG RESPONSE");
                    hexlogger.log(response);
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