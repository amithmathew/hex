import * as vscode from 'vscode';
import { hexlogger } from './extension';
import { getVendorModelFromModelString } from './helpers';

interface ModifyCodeOptions {
    signal?: AbortSignal; // optional signal property
}

export class Hex {
    private context: vscode.ExtensionContext;
    private llm: any;
    private vendor: string;
    private model: string;
        

    private modifyCodePrompt: string;

    constructor(context: vscode.ExtensionContext) {
        this.context = context;

        let modelString = vscode.workspace.getConfiguration('hex').get<string>('model');
        if (!modelString) {
            vscode.window.showErrorMessage("Model not set in extension settings!");
            throw new Error("Model not set in extension settings. Cannot initialize Hex.");
        } else {
            const { vendor, model } = getVendorModelFromModelString(modelString);
            this.vendor = vendor;
            this.model = model;
        }
        let mp = vscode.workspace.getConfiguration('hex').get<string>('ModifyCodePrompt');
        if (!mp) {
            this.modifyCodePrompt = "You are an expert software developer. Modify the code provided following these instructions. Your response will be pasted directly into the code file. Do not wrap your response in any sort of commentary or markdown code blocks, as that will break the code file.\n";
        } else {
            this.modifyCodePrompt = mp;
        }
    }

    public async initialize() {
        let llmplugin;
        switch (this.vendor) {
            case 'OpenAI':
                llmplugin = await import('./llm/HexOpenAI.js');
                this.llm = new llmplugin.HexOpenAI();
                await this.llm.initialize(this.vendor, this.model);
                break;
            case 'Google for Developers':
                llmplugin = await import('./llm/HexGoogleDevGemini.js');
                this.llm = new llmplugin.HexGoogleDevGemini();
                await this.llm.initialize(this.vendor, this.model);
                break;
            default:
                throw new Error('Unsupported LLM vendor ' + this.vendor);
        }
    }

    public async modifyCode(options: ModifyCodeOptions, prompt: string, code: string, original_code?: string) {
        const { signal } = options || {};

        // check if the request has already been aborted
        if (signal && signal.aborted) {
            throw new Error('request aborted'); // or handle it in another way
        }

        // The messages object is complicated because
        // we want to support multimodal input in the future.
        const messages = 
            original_code ? 
                [
                    {   role: "user", 
                        content: [
                            {   type: "text",
                                data: this.modifyCodePrompt.concat(
                                        "\n", prompt, 
                                        "\n\noriginal code for context:\n", original_code, 
                                        "\n\npreviously modified code to be changed now:\n", 
                                        code)
                            },
                        ] 
                    }
                ]
            : 
                [
                    { 
                        role: "user", 
                        content: [
                            {
                                type: "text",
                                data: this.modifyCodePrompt.concat("\n", prompt, "\n\ncode:\n", code)
                            },
                        ]
                    },
            ];
        hexlogger.log("Making LLM call.");
        //console.log(messages);

        //const tool_choice = {"type": "function", "function": {"name": "replace_code"}};
        //console.log(messages);
        const modifiedCode = await this.llm.modifyCode(messages, signal);
        hexlogger.log("Received response.");
        hexlogger.log(modifiedCode);
        return modifiedCode;
    }

}