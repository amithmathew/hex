import * as vscode from 'vscode';
import { hexlogger } from './extension';
import { LLM } from './LLM';

interface ModifyCodeOptions {
    signal?: AbortSignal; // optional signal property
}

export class Hex {
    private context: vscode.ExtensionContext;
    private llm: any;

    private modifyCodePrompt: string;


    private tools = [
        {
            type: "function",
            function: {
                name: "replace_code",
                description: "Replaces existing code block with the code passed to this function.",
                parameters: {
                    type: "object",
                    properties: {
                        code: {
                            type: "string",
                            description: "The code to be inserted verbatim. Does not accept markdown code fences."
                        }
                    },
                    required: ["code"],
                }
            }
        },
    ];

    constructor(context: vscode.ExtensionContext) {
        this.context = context;

        let modelString = vscode.workspace.getConfiguration('hex').get<string>('model');
        if (!modelString) {
            vscode.window.showErrorMessage("Model not set in extension settings!");
            throw new Error("Model not set in extension settings. Cannot initialize Hex.");
        } else {
            this.llm = new LLM(modelString);
        }

        let mp = vscode.workspace.getConfiguration('hex').get<string>('ModifyCodePrompt');
        if (!mp) {
            this.modifyCodePrompt = "You are an expert software developer. Modify the code provided following these instructions.";
        } else {
            this.modifyCodePrompt = mp;
        }
    }

    public async initialize() {
        await this.llm.initialize();
    }

    public async modifyCode(options: ModifyCodeOptions, prompt: string, code: string, original_code?: string) {
        const { signal } = options || {};

        // check if the request has already been aborted
        if (signal && signal.aborted) {
            throw new Error('request aborted'); // or handle it in another way
        }

        const messages = [
            original_code ? 
            {   role: "user", 
                content: this.modifyCodePrompt.concat("\n", prompt, "\n\noriginal code for context:\n", original_code, "\n\npreviously modified code to be changed now:\n", code) }
            : { 
                role: "user", 
                content: this.modifyCodePrompt.concat("\n", prompt, "\n\ncode:\n", code)
            },
        ];
        hexlogger.log("Making LLM call.");

        const tool_choice = {"type": "function", "function": {"name": "replace_code"}};
        //console.log(messages);
        const functionArgs = await this.llm.chatCompletion(messages, this.tools, tool_choice, signal);
        //const response = await this.openai.chat.completions.create(
        //    {
        //        model: this.model,
        //       messages: messages,
        //        tools: this.tools,
        //        tool_choice: {"type": "function", "function": {"name": "replace_code"}},
        //    },
        //    {
        //        signal: signal,
        //    }
        //);
        //console.log(response);
        //console.log(response.choices[0].message.tool_calls[0].function.arguments);
        //const functionArgs = JSON.parse(response.choices[0].message.tool_calls[0].function.arguments);
        //console.log(functionArgs.comment);
        hexlogger.log("Received response.");
        return functionArgs.code;
    }

}