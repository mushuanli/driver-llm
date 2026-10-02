// @file: driver-llm/core/chain.ts

import { LLMDriver } from './driver';
import { ChatCompletionParams } from '../types';

/**
 * 链式步骤配置
 */
interface ChainStep {
    /** Prompt 模板 */
    promptTemplate: string;
    
    /** 输入变量名列表 */
    inputVariables: string[];
    
    /** 输出变量名 */
    outputVariable: string;
    
    /** LLM 参数覆盖 */
    llmConfig?: Partial<ChatCompletionParams>;
}

/**
 * LLM Chain - 简单的链式调用
 * 
 * 用于需要多步骤处理的场景，如：
 * 1. 提取关键信息 → 生成回复
 * 2. 翻译 → 总结
 */
export class LLMChain {
    private steps: ChainStep[] = [];
    
    constructor(private driver: LLMDriver) {}
    
    /**
     * 添加步骤
     */
    add(
        config: {
            promptTemplate: string;
            inputVariables: string[];
            outputVariable: string;
        },
        llmConfig: Partial<ChatCompletionParams> = {}
    ): LLMChain {
        this.steps.push({ ...config, llmConfig });
        return this;
    }
    
    /**
     * 执行链
     */
    async run(initialContext: Record<string, any> = {}): Promise<Record<string, any>> {
        let context = { ...initialContext };
        
        for (const step of this.steps) {
            // 1. 替换模板变量
            let prompt = step.promptTemplate;
            for (const key of step.inputVariables) {
                const value = context[key];
                const replacement = typeof value === 'string' ? value : JSON.stringify(value);
                prompt = prompt.replace(new RegExp(`\\{${key}\\}`, 'g'), replacement || '');
            }
            
            // 2. 调用 LLM
            const response = await this.driver.chat.create({
                messages: [{ role: 'user', content: prompt }],
                ...step.llmConfig,
                stream: false
            });
            
            // 3. 提取结果
            const content = response.choices[0]?.message?.content || '';
            context[step.outputVariable] = content;
        }
        
        return context;
    }
    
    /**
     * 清除步骤
     */
    clear(): LLMChain {
        this.steps = [];
        return this;
    }
    
    /**
     * 获取步骤数量
     */
    get length(): number {
        return this.steps.length;
    }
}
