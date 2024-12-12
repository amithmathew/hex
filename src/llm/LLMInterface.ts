export interface LLMInterface {
    vendor: string | undefined;
    model: string | undefined;
    initialize(vendor: string, model: string): Promise<void>;
    modifyCode(messages: any[], signal: AbortSignal, llm_options?: Record<string, any>): Promise<any>;
}