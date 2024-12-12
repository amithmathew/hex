import * as vscode from 'vscode';

import { LLMInterface } from './LLMInterface';


import OpenAI from "openai";
import { zodResponseFormat } from "openai/helpers/zod";
import { z } from "zod";

import { hexlogger } from '../extension';
import { getVendorModelFromModelString } from '../helpers';


export class HexOpenAI implements LLMInterface {

    public vendor: string | undefined;
    public model: string | undefined;
    private config: vscode.WorkspaceConfiguration | undefined;
    private apiKey: string | undefined;
    private openai: OpenAI | undefined;

    readonly ModifiedCode = z.object({
        code: z.string()
    });
    
    public async initialize(vendor: string, model: string) {
        this.vendor = vendor;
        this.model = model;
        this.config = vscode.workspace.getConfiguration('hex');
        vscode.window.showInformationMessage(`Using ${vendor} model ${model}`);

        this.apiKey = this.config.get<string>('OpenaiApiKey') ?? 
                    ( () => { throw new Error('OpenAI model selected but API Key is not defined.'); })();
        this.openai = new OpenAI({apiKey: this.apiKey});
    }

    public async modifyCode(messages: [any], signal: AbortSignal, llm_options: Record<string, any> ) {
        if(this.openai === undefined) {
            throw new Error('OpenAI not initialized.');
        }
        if(this.model === undefined) {
            throw new Error('Model name unknown.');
        }
        try {
            let response;

            // OpenAI messages are a list of the form
            // [    
            //      { role: "system", content: "You are a helpful assistant" },
            //      { role: "user", content: "Write a haiku about AGI" }
            // ]
            let formatted_messages = messages.map(
                    (message: { role: any; content: any; }) => (
                        {
                            role: message.role,
                            content: Array.isArray(message.content) ? 
                                        message.content.map(c => c.data).join('\n')
                                        : message.content,
                        }
                    )
                );
            hexlogger.log("OpenAI Messages: ");
            hexlogger.log(JSON.stringify(formatted_messages, undefined, 2));
            response = await this.openai.beta.chat.completions.parse(
                        {
                            model: this.model,
                            messages: formatted_messages,
                            response_format: zodResponseFormat(this.ModifiedCode, "code"),
                            ...llm_options
                        },
                        { signal: signal, }
            );
            let modifiedCode: {code: string}|null = response.choices[0].message.parsed;
            hexlogger.log(JSON.stringify(modifiedCode, undefined, 2));
            
            if (modifiedCode) {
                return modifiedCode.code;
              } else {
                return ''; // Or any other default value you prefer
              }
        }
        catch (error: unknown) {
            const errorMessage = (error instanceof Error) ? error.message : `An unknown error occurred: ${error}`;
            hexlogger.log(`Error in OpenAI call: ${errorMessage}`);
            vscode.window.showErrorMessage(`Error during API call: ${errorMessage}`);
            throw error;
        }
    }
}