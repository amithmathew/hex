import * as vscode from 'vscode';

import { LLMInterface } from './LLMInterface';

import { GoogleGenerativeAI, SchemaType } from "@google/generative-ai";

import { hexlogger } from '../extension';


export class HexGoogleDevGemini implements LLMInterface {

    public vendor: string | undefined;
    public model: string | undefined;
    private config: vscode.WorkspaceConfiguration | undefined;
    private apiKey: string | undefined;
    private genai: GoogleGenerativeAI | undefined;
    private structured_gemini: any;


    readonly ModifiedCodeSchema = {
        type: SchemaType.OBJECT,
        properties: {
            code: {
                type: SchemaType.STRING,
                description: "Modified Code",
                nullable: false
            }
          },
          required: ["code"],
      };

    readonly GenerationConfig = {
        responseMimeType: "application/json",
        responseSchema: this.ModifiedCodeSchema,
        //maxOutputTokens: 1000,
        //temperature: 0.1,
    };
    
    public async initialize(vendor: string, model: string) {
        this.vendor = vendor;
        this.model = model;
        this.config = vscode.workspace.getConfiguration('hex');
        vscode.window.showInformationMessage(`Using ${vendor} model ${model}`);

        this.apiKey = this.config.get<string>('GoogleDevApiKey') ?? 
                    ( () => { throw new Error('Google for Developers model selected but API Key is not defined.'); })();
        this.genai = new GoogleGenerativeAI(this.apiKey);
        this.structured_gemini = this.genai.getGenerativeModel({
            model: this.model,
            //generationConfig: {
            //  responseMimeType: "application/json",
            //  responseSchema: this.ModifiedCodeSchema,
            //},
          });
    }

    public async modifyCode(messages: [any], signal: AbortSignal, llm_options: Record<string, any> ) {
        if(this.structured_gemini === undefined) {
            throw new Error('Google for Developers Gemini model is not initialized.');
        }
        if(this.model === undefined) {
            throw new Error('Model name unknown.');
        }
        try {
            let result;

            // Google for Devs expects a request object to look something like this
            //request = {
            //    contents: [{role: 'user', parts: [{text: 'How are you doing today?'}]}],
            //    systemInstruction: { role: 'system', parts: [{ text: `For example, you are a helpful customer service agent.` }] },
            //  };
            let contents_array = messages.map(
                (message: { role: any; content: any; }) => (
                    {
                        role: message.role,
                        parts: Array.isArray(message.content) ? 
                                    message.content.map(c => ({[c.type]: c.data}))
                                    : message.content,
                    }
                )
            );
            hexlogger.log("GoogleForDevs Messages: ");
            hexlogger.log(JSON.stringify(contents_array, undefined, 2));
            result = await this.structured_gemini.generateContent(
                {
                    contents: contents_array,
                    generationConfig: this.GenerationConfig
                }
            );
            let modifiedCode: {code: string}|null = JSON.parse(result.response.text());
            hexlogger.log(JSON.stringify(modifiedCode, undefined, 2));
            
            if (modifiedCode) {
                return modifiedCode.code;
              } else {
                return ''; // Or any other default value you prefer
              }
        }
        catch (error: unknown) {
            const errorMessage = (error instanceof Error) ? error.message : `An unknown error occurred: ${error}`;
            hexlogger.log(`Error in Google for Developers Gemini call: ${errorMessage}`);
            vscode.window.showErrorMessage(`Error during API call: ${errorMessage}`);
            throw error;
        }
    }
}