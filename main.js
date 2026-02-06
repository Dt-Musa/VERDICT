
        // ==========================================
        // THEME SYSTEM - Dark/Light Mode
        // ==========================================
        (function initTheme() {
            const savedTheme = localStorage.getItem('verdict-theme');
            const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
            
            // Default to dark mode, use saved preference if available
            const theme = savedTheme || (prefersDark ? 'dark' : 'dark');
            document.documentElement.setAttribute('data-theme', theme);
        })();
        
        function toggleTheme() {
            const currentTheme = document.documentElement.getAttribute('data-theme');
            const newTheme = currentTheme === 'dark' ? 'light' : 'dark';
            
            document.documentElement.setAttribute('data-theme', newTheme);
            localStorage.setItem('verdict-theme', newTheme);
        }
        
        // Initialize theme toggle after DOM loads
        document.addEventListener('DOMContentLoaded', function() {
            const themeToggle = document.getElementById('theme-toggle');
            if (themeToggle) {
                themeToggle.addEventListener('click', toggleTheme);
            }
        });
        
        // Global configuration
        let USE_MOCK_MODE = true; // Set to false when using real API with your own API key
        
        /* ==========================================
           INTENT VERIFICATION STATE MACHINE
           ==================================
           
           PRODUCT IDENTITY:
           This application verifies that a smart contract's actual behavior
           matches the user's stated intent BEFORE execution.
           
           STATE 1: CAPTURE_INTENT
           → User enters intent in natural language
           → No auto-advancement
           → User clicks "Continue" to proceed
           
           STATE 2: CLARIFY (optional, one question at a time)
           → If intent is ambiguous, ask ONE clarification question
           → Clarification answer UPDATES the existing intent (does not replace)
           → After answer, show updated intent interpretation
           → User must explicitly confirm to proceed
           
           STATE 3: CONFIRM_INTENT
           → Display final interpreted intent in plain English
           → User must explicitly confirm this is what they want
           → No execution until explicit confirmation
           
           STATE 4: EXECUTE (only after explicit confirmation)
           → Generate execution JSON
           → Proceed to execution
           
           RULES:
           - No automatic step transitions
           - Clarification updates intent, does not replace it
           - No risk analysis or safety warnings in flow
           - Explicit confirmation required at each step
        */
        
        // Application State - Intent Verification State Machine
        let appState = {
            // Current UI state
            currentView: 'intent-input',
            currentStep: 'CAPTURE_INTENT', // CAPTURE_INTENT | CLARIFY | CONFIRM_INTENT | EXECUTE
            
            // Intent tracking
            originalIntent: '',
            interpretedIntent: '', // Updated by clarifications
            clarificationHistory: [], // Array of {question, answer} pairs
            
            // Execution data (only populated after confirmation)
            executionJSON: null,
            
            // Flags
            intentConfirmed: false,
            awaitingUserAction: true // Prevents auto-advancement
        };
        
        // Assistant State for conversation loop
        let assistantState = null;
        let conversationHistory = [];

        // Helper function to generate simple hash for intent comparison
        function generateIntentHash(intent) {
            // Simple hash function for frontend-only intent tracking
            let hash = 0;
            for (let i = 0; i < intent.length; i++) {
                const char = intent.charCodeAt(i);
                hash = ((hash << 5) - hash) + char;
                hash = hash & hash; // Convert to 32-bit integer
            }
            return hash.toString();
        }

        // Persist state to localStorage to prevent accidental resets
        function persistState() {
            try {
                localStorage.setItem('contractSafetyAppState', JSON.stringify(appState));
                localStorage.setItem('contractSafetyAssistantState', assistantState || '');
                localStorage.setItem('contractSafetyConversationHistory', JSON.stringify(conversationHistory));
            } catch (error) {
                console.warn('Failed to persist state to localStorage:', error);
            }
        }

        // Load state from localStorage
        function loadPersistedState() {
            try {
                const persistedAppState = localStorage.getItem('contractSafetyAppState');
                const persistedAssistantState = localStorage.getItem('contractSafetyAssistantState');
                const persistedConversationHistory = localStorage.getItem('contractSafetyConversationHistory');
                
                if (persistedAppState) {
                    appState = JSON.parse(persistedAppState);
                }
                if (persistedAssistantState) {
                    assistantState = persistedAssistantState || null;
                }
                if (persistedConversationHistory) {
                    conversationHistory = JSON.parse(persistedConversationHistory);
                }
            } catch (error) {
                console.warn('Failed to load persisted state:', error);
            }
        }

        // Clear persisted state
        function clearPersistedState() {
            try {
                localStorage.removeItem('contractSafetyAppState');
                localStorage.removeItem('contractSafetyAssistantState');
                localStorage.removeItem('contractSafetyConversationHistory');
            } catch (error) {
                console.warn('Failed to clear persisted state:', error);
            }
        }

        const examples = [
            "Release payment to the freelancer once the project is marked as complete.",
            "Swap 1 ETH to USDC on Uniswap at market price.",
            "Refund the customer if the item has not shipped within 7 days."
        ];

        // ==========================================
        // PLAIN ENGLISH EXPLANATION ENGINE
        // ==========================================
        
        async function generatePlainEnglishExplanation(finalIntent) {
            const systemPrompt = `You are a deterministic Intent Explanation Engine for a Web3 safety application.

Your ONLY job: Explain what the user is about to approve in plain English.

ABSOLUTE RULES (DO NOT BREAK):
- Do NOT repeat the user's words
- Do NOT summarize the input
- Do NOT reassure the user
- Do NOT mention developers, audits, Solidity, gas, or blockchain internals
- Do NOT say "this seems safe"
- Use simple language for a non-technical person
- If details are missing, you MUST say so

OUTPUT MUST MATCH THIS FORMAT EXACTLY.
If you cannot follow the format, output:
"Unable to generate a safe explanation."

FORMAT:

PLAIN ENGLISH EXPLANATION

What will happen:
- 

Who is affected:
- 

What could go wrong:
- 

What cannot be undone:
- `;

            try {
                const response = await callLLM(systemPrompt, finalIntent);
                return parsePlainEnglishExplanation(response);
            } catch (error) {
                console.error('Plain English explanation error:', error);
                return null;
            }
        }
        
        function parsePlainEnglishExplanation(aiResponse) {
            const sections = {
                whatWillHappen: [],
                whoIsAffected: [],
                whatCouldGoWrong: [],
                whatCannotBeUndone: []
            };
            
            const lines = aiResponse.split('\n').map(line => line.trim()).filter(line => line);
            let currentSection = null;
            
            for (const line of lines) {
                if (line === 'What will happen:') {
                    currentSection = 'whatWillHappen';
                } else if (line === 'Who is affected:') {
                    currentSection = 'whoIsAffected';
                } else if (line === 'What could go wrong:') {
                    currentSection = 'whatCouldGoWrong';
                } else if (line === 'What cannot be undone:') {
                    currentSection = 'whatCannotBeUndone';
                } else if (line.startsWith('- ') && currentSection) {
                    const content = line.substring(2).trim();
                    if (content) {
                        sections[currentSection].push(content);
                    }
                }
            }
            
            // Check if all sections have content
            const hasAllSections = Object.values(sections).every(section => section.length > 0);
            
            // Identify missing sections for clarification
            const missingSections = [];
            if (sections.whatWillHappen.length === 0) missingSections.push('whatWillHappen');
            if (sections.whoIsAffected.length === 0) missingSections.push('whoIsAffected');
            if (sections.whatCouldGoWrong.length === 0) missingSections.push('whatCouldGoWrong');
            if (sections.whatCannotBeUndone.length === 0) missingSections.push('whatCannotBeUndone');
            
            return hasAllSections ? sections : { sections, missingSections, isIncomplete: true };
        }
        
        function renderPlainEnglishExplanation(explanation) {
            if (!explanation || explanation.isIncomplete) {
                const missingSection = explanation?.missingSections?.[0];
                const sectionName = getSectionDisplayName(missingSection);
                
                return `<div class="alert-warning mb-6">
                    <div class="flex gap-3">
                        <svg class="w-5 h-5 text-yellow-500 flex-shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                        </svg>
                        <p class="text-sm leading-relaxed">We need one more detail to explain this safely: ${sectionName}</p>
                    </div>
                </div>`;
            }
            
            return `
                <div class="space-y-4 mb-6">
                    <div class="card">
                        <h4 class="text-sm font-medium mb-2 opacity-70">What will happen:</h4>
                        <ul class="space-y-1">
                            ${explanation.whatWillHappen.map(item => 
                                `<li class="text-sm flex gap-2">
                                    <span class="text-cyan-400 mt-1">•</span>
                                    <span>${item}</span>
                                </li>`
                            ).join('')}
                        </ul>
                    </div>
                    
                    <div class="card">
                        <h4 class="text-sm font-medium mb-2 opacity-70">Who is affected:</h4>
                        <ul class="space-y-1">
                            ${explanation.whoIsAffected.map(item => 
                                `<li class="text-sm flex gap-2">
                                    <span class="text-cyan-400 mt-1">•</span>
                                    <span>${item}</span>
                                </li>`
                            ).join('')}
                        </ul>
                    </div>
                    
                    <div class="card">
                        <h4 class="text-sm font-medium mb-2 opacity-70">What could go wrong:</h4>
                        <ul class="space-y-1">
                            ${explanation.whatCouldGoWrong.map(item => 
                                `<li class="text-sm flex gap-2">
                                    <span class="text-yellow-500 mt-1">•</span>
                                    <span>${item}</span>
                                </li>`
                            ).join('')}
                        </ul>
                    </div>
                    
                    <div class="card">
                        <h4 class="text-sm font-medium mb-2 opacity-70">What cannot be undone:</h4>
                        <ul class="space-y-1">
                            ${explanation.whatCannotBeUndone.map(item => 
                                `<li class="text-sm flex gap-2">
                                    <span class="text-red-400 mt-1">•</span>
                                    <span>${item}</span>
                                </li>`
                            ).join('')}
                        </ul>
                    </div>
                </div>
            `;
        }
        
        function getSectionDisplayName(sectionKey) {
            const names = {
                'whatWillHappen': 'What will happen',
                'whoIsAffected': 'Who is affected', 
                'whatCouldGoWrong': 'What could go wrong',
                'whatCannotBeUndone': 'What cannot be undone'
            };
            return names[sectionKey] || 'Missing details';
        }
        
        async function generateClarificationQuestion(missingSection, intent, previousAnswers) {
            // Transaction Safety Gate - fixed safety questions only
            const questions = [
                "Do you recognize and trust the contract requesting this action?",
                "Does this action require token approval or wallet signature?",
                "Do you understand this action cannot be reversed once confirmed?"
            ];
            const questionIndex = Math.min(appState.explanationClarificationAttempts, questions.length - 1);
            return questions[questionIndex];
        }
        
        async function regenerateExplanationWithClarification(intent, clarificationHistory) {
            const systemPrompt = `You are a deterministic Intent Explanation Engine for a Web3 safety application.

Your ONLY job: Explain what the user is about to approve in plain English.

User intent: "${intent}"
User clarifications: ${clarificationHistory.map((c, i) => `Q${i+1}: ${c.question} A${i+1}: ${c.answer}`).join('; ')}

ABSOLUTE RULES (DO NOT BREAK):
- Do NOT repeat the user's words
- Do NOT summarize the input
- Do NOT reassure the user
- Do NOT mention developers, audits, Solidity, gas, or blockchain internals
- Do NOT say "this seems safe"
- Use simple language for a non-technical person
- If details are missing, you MUST say so
- Use clarifications to complete missing sections

OUTPUT MUST MATCH THIS FORMAT EXACTLY.
If you cannot follow the format, output:
"Unable to generate a safe explanation."

FORMAT:

PLAIN ENGLISH EXPLANATION

What will happen:
- 

Who is affected:
- 

What could go wrong:
- 

What cannot be undone:
- `;

            try {
                const response = await callLLM(systemPrompt, 'Explain with clarifications:');
                return parsePlainEnglishExplanation(response);
            } catch (error) {
                console.error('Regenerate explanation error:', error);
                return null;
            }
        }
        
        // ==========================================
        // LLM API INTEGRATION
        // ==========================================
        
        async function callLLM(systemPrompt, userPrompt) {
            // Check if we're using mock mode
            if (USE_MOCK_MODE) {
                console.log('Using mock mode for LLM API');
                return mockLLMResponse(systemPrompt, userPrompt);
            }
            
            try {
                // Replace this with your actual API key when not using mock mode
                const API_KEY = 'YOUR_ANTHROPIC_API_KEY';
                const response = await fetch('https://api.anthropic.com/v1/messages', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'anthropic-version': '2023-06-01',
                        'x-api-key': API_KEY
                    },
                    body: JSON.stringify({
                        model: 'claude-sonnet-4-20250514',
                        max_tokens: 1000,
                        system: systemPrompt,
                        messages: [{ role: 'user', content: userPrompt }]
                    })
                });

                if (!response.ok) {
                    throw new Error(`API Error: ${response.status} ${response.statusText}`);
                }

                const data = await response.json();
                return data.content
                    .filter(item => item.type === 'text')
                    .map(item => item.text)
                    .join('\n');
            } catch (error) {
                console.error('LLM API Error:', error);
                throw error;
            }
        }
        
        // Mock LLM response function for testing without API key
        function mockLLMResponse(systemPrompt, userPrompt) {
            console.log('Mock LLM received:', { systemPrompt, userPrompt });
            
            // Detect what type of response to generate based on the prompt
            if (systemPrompt.includes('Transaction Safety Gate')) {
                // For detectAmbiguity function
                const promptLower = userPrompt.toLowerCase();
                const isClarification = promptLower.includes('original intent') && promptLower.includes('user clarification');
                
                if (isClarification) {
                    const clarificationMatch = userPrompt.match(/User clarification:\s*"([^"]+)"/i);
                    const userAnswer = clarificationMatch ? clarificationMatch[1].toLowerCase() : '';
                    const positiveResponses = ['yes', 'i trust', 'i understand', 'i accept', 'correct', 'confirmed', 'i do', 'i am aware', 'i know'];
                    const isPositive = positiveResponses.some(resp => userAnswer.includes(resp));
                    
                    if (isPositive) {
                        return 'STATE: INTENT_VERIFIED\n\nIntent verified. You may proceed to execution.';
                    }
                    
                    return 'STATE: CLARIFICATION_REQUIRED\n\nDo you recognize and trust the contract requesting this action?';
                }
                
                if (promptLower.includes('swap') || promptLower.includes('transfer') || promptLower.includes('send')) {
                    return 'STATE: CLARIFICATION_REQUIRED\n\nDo you recognize and trust the contract requesting this action?';
                }
                
                return 'STATE: INTENT_VERIFIED\n\nIntent verified. You may proceed to execution.';
            } else if (systemPrompt.includes('Intent Explanation Engine') || systemPrompt.includes('PLAIN ENGLISH EXPLANATION')) {
                // For generatePlainEnglishExplanation function - dynamic based on intent
                const intentLower = userPrompt.toLowerCase();
                
                let whatWillHappen, whoIsAffected, whatCouldGoWrong, whatCannotBeUndone;
                
                if (intentLower.includes('swap')) {
                    whatWillHappen = '- Your tokens will be exchanged for a different token\n- The swap will execute at the current market rate';
                    whoIsAffected = '- You will receive the new tokens\n- The liquidity pool will process the exchange';
                    whatCouldGoWrong = '- Price slippage may result in fewer tokens than expected\n- The swap could fail if liquidity is insufficient';
                    whatCannotBeUndone = '- Once swapped, you cannot reverse the exchange\n- Any slippage loss is permanent';
                } else if (intentLower.includes('send') || intentLower.includes('transfer')) {
                    whatWillHappen = '- Your funds will be sent to the specified address\n- The transaction will be recorded on the blockchain';
                    whoIsAffected = '- You will lose the specified amount\n- The recipient will receive the funds';
                    whatCouldGoWrong = '- The recipient address could be incorrect\n- The transaction could fail due to network issues';
                    whatCannotBeUndone = '- Once sent, you cannot retrieve the funds\n- If sent to wrong address, funds are lost forever';
                } else if (intentLower.includes('approve') || intentLower.includes('permission')) {
                    whatWillHappen = '- You will grant a contract permission to spend your tokens\n- The approval will remain active until revoked';
                    whoIsAffected = '- Your wallet will have an active approval\n- The approved contract can move your tokens';
                    whatCouldGoWrong = '- A malicious contract could drain your approved tokens\n- Unlimited approvals are especially risky';
                    whatCannotBeUndone = '- Approvals persist until manually revoked\n- Any tokens moved by the contract cannot be recovered';
                } else if (intentLower.includes('stake') || intentLower.includes('deposit')) {
                    whatWillHappen = '- Your tokens will be locked in a staking contract\n- You may earn rewards over time';
                    whoIsAffected = '- Your tokens will be inaccessible during the lock period\n- The staking protocol will hold your funds';
                    whatCouldGoWrong = '- The staking contract could have vulnerabilities\n- Rewards may be lower than expected';
                    whatCannotBeUndone = '- Unstaking may require a waiting period\n- Early withdrawal may incur penalties';
                } else if (intentLower.includes('refund')) {
                    whatWillHappen = '- A refund will be issued to the original sender\n- The refund amount will be deducted from your balance';
                    whoIsAffected = '- You will lose the refunded amount\n- The original sender will receive their funds back';
                    whatCouldGoWrong = '- The refund address could be incorrect\n- Partial refunds may cause disputes';
                    whatCannotBeUndone = '- Once refunded, you cannot reclaim the funds\n- The transaction is final';
                } else if (intentLower.includes('release') || intentLower.includes('payment')) {
                    whatWillHappen = '- Payment will be released to the recipient\n- The funds will leave your control';
                    whoIsAffected = '- You will transfer the payment amount\n- The recipient will receive the funds';
                    whatCouldGoWrong = '- The recipient may not deliver the expected service\n- Payment disputes cannot be resolved on-chain';
                    whatCannotBeUndone = '- Once released, payment cannot be reversed\n- You lose all claim to the funds';
                } else {
                    whatWillHappen = '- The requested action will be executed\n- Your wallet state will be updated';
                    whoIsAffected = '- You as the initiator of this action\n- Any counterparties involved in the transaction';
                    whatCouldGoWrong = '- Unexpected contract behavior is possible\n- Network conditions may affect the outcome';
                    whatCannotBeUndone = '- Blockchain transactions are permanent\n- No undo function exists for on-chain actions';
                }
                
                return `PLAIN ENGLISH EXPLANATION

What will happen:
${whatWillHappen}

Who is affected:
${whoIsAffected}

What could go wrong:
${whatCouldGoWrong}

What cannot be undone:
${whatCannotBeUndone}`;
            } else if (systemPrompt.includes('structured execution condition')) {
                // For generateExecutionJSON function
                return JSON.stringify({
                    trigger_type: 'manual',
                    data_source: 'manual',
                    condition: 'user_approval',
                    action: 'release',
                    deadline: null
                }, null, 2);
            } else if (systemPrompt.includes('potential risks')) {
                // For analyzeRisks function
                return '- Once executed, this transaction cannot be reversed\n- If the recipient address is incorrect, your funds may be lost';
            } else if (systemPrompt.includes('Intent Interpreter')) {
                // For generateIntentInterpretation and updateIntentWithClarification
                const intentLower = userPrompt.toLowerCase();
                
                // Check if this is an update with clarifications
                if (systemPrompt.includes('CLARIFICATIONS PROVIDED')) {
                    // Clarification was provided - return complete interpretation
                    let interpretation = '';
                    if (intentLower.includes('swap')) {
                        interpretation = `You want to swap tokens. Based on your clarification, the swap will execute at the specified parameters.`;
                    } else if (intentLower.includes('send') || intentLower.includes('transfer')) {
                        interpretation = `You want to send funds to the specified recipient address.`;
                    } else if (intentLower.includes('release') || intentLower.includes('payment')) {
                        interpretation = `You want to release payment to the recipient once conditions are met.`;
                    } else if (intentLower.includes('refund')) {
                        interpretation = `You want to issue a refund to the original sender.`;
                    } else {
                        interpretation = `You want to execute the action: ${userPrompt}`;
                    }
                    return `NEEDS_CLARIFICATION: false\nINTERPRETATION: ${interpretation}`;
                }
                
                // Initial interpretation - check if clarification needed
                const needsClarification = !intentLower.includes('eth') && !intentLower.includes('usdc') && 
                    (intentLower.includes('swap') || intentLower.includes('send') || intentLower.includes('transfer'));
                
                if (needsClarification) {
                    let question = 'What amount would you like to use for this transaction?';
                    let currentInterp = `You want to ${intentLower.includes('swap') ? 'swap tokens' : 'transfer funds'}`;
                    return `NEEDS_CLARIFICATION: true\nQUESTION: ${question}\nCURRENT_INTERPRETATION: ${currentInterp}`;
                }
                
                // Intent is clear
                let interpretation = '';
                if (intentLower.includes('swap')) {
                    interpretation = `You want to exchange your tokens at the current market rate.`;
                } else if (intentLower.includes('send') || intentLower.includes('transfer')) {
                    interpretation = `You want to send funds to the specified address.`;
                } else if (intentLower.includes('release') || intentLower.includes('payment')) {
                    interpretation = `You want to release payment once the specified conditions are met.`;
                } else if (intentLower.includes('refund')) {
                    interpretation = `You want to issue a refund based on the stated conditions.`;
                } else if (intentLower.includes('stake') || intentLower.includes('deposit')) {
                    interpretation = `You want to stake or deposit your tokens into the protocol.`;
                } else {
                    interpretation = `You want to execute: ${userPrompt}`;
                }
                return `NEEDS_CLARIFICATION: false\nINTERPRETATION: ${interpretation}`;
            } else {
                // Default response
                return 'NEEDS_CLARIFICATION: false\nINTERPRETATION: The requested action will be executed as specified.';
            }
        }

        // ==========================================
        // PROMPT CHAINING FUNCTIONS
        // ==========================================

        // Step 1: Explain Intent in Plain English
        async function explainIntent(userIntent) {
            const systemPrompt = `You are an AI confirmation assistant for blockchain actions.
Your role is to protect users from executing smart contracts they do not fully understand.

Analyze the following user intent.

User intent:
"${userIntent}"

Explain in simple, plain English what will happen if this intent is executed.

Constraints:
- Maximum 3 short sentences
- Do not add assumptions
- Do not introduce new conditions`;

            try {
                const explanation = await callLLM(systemPrompt, 'Explain what will happen:');
                return explanation.trim();
            } catch (error) {
                console.error('Explain intent error:', error);
                return `You want to: ${userIntent}`;
            }
        }

        // Step 2: Detect Ambiguity - Contract Safety Assistant
        async function detectAmbiguity(userIntent) {
            const systemPrompt = `You are NOT a conversational assistant. You are a Transaction Safety Gate.

Your ONLY job is to classify user input into ONE of these states:

STATE 1: Intent Incomplete
STATE 2: Safety Clarification Required
STATE 3: Ready for Execution
STATE 4: High Risk – Block Execution

GLOBAL RULES:
- NEVER ask open-ended questions
- NEVER ask “when”, “how”, or “provide more details”
- NEVER rephrase user intent
- ALWAYS respond with a single, fixed-format safety question OR a state decision

STATE 1 – Intent Incomplete (Trigger if asset, action, or platform is missing)
Response format:
"To continue, confirm this one detail: [specific missing item]"

STATE 2 – Safety Clarification Required (Trigger if financial risk exists, contract trust is unclear, or permissions may be requested)
Response format (choose ONE only):
- "Do you recognize and trust the contract requesting this action?"
- "Does this action require token approval or wallet signature?"
- "Do you understand this action cannot be reversed once confirmed?"

STATE 3 – Ready for Execution (Trigger ONLY if intent is clear, platform is known, risk is acknowledged)
Response format:
"Intent verified. You may proceed to execution."

STATE 4 – High Risk – Block Execution (Trigger if third-party claims, unknown source, or social engineering detected)
Response format:
"Execution blocked due to unresolved safety risk."

CRITICAL:
- You may ask ONLY ONE question per response
- You may NOT ask follow-up questions unless the previous one is answered
- You may NOT invent questions
- If no valid safety question applies, BLOCK execution

User input: "${userIntent}"

Return the single required state response.`;

            try {
                const response = await callLLM(systemPrompt, 'Analyze for safety:');
                console.log('AI Response:', response);
                
                // Parse the state-based response - accept STATE: or STATE 1-4 formats
                const lines = response.split('\n');
                let stateLine = null;
                let message = '';
                
                for (const line of lines) {
                    const trimmed = line.trim();
                    if (trimmed.startsWith('STATE:') || trimmed.startsWith('STATE 1') || trimmed.startsWith('STATE 2') || trimmed.startsWith('STATE 3') || trimmed.startsWith('STATE 4')) {
                        stateLine = trimmed;
                        break;
                    }
                }
                
                if (!stateLine) {
                    const responseLower = response.toLowerCase();
                    if (responseLower.includes('intent verified')) {
                        assistantState = 'INTENT_VERIFIED';
                        return { status: 'CLEAR' };
                    }
                    if (responseLower.includes('execution blocked')) {
                        assistantState = 'EXECUTION_BLOCKED';
                        return {
                            status: 'BLOCKED',
                            message: 'Execution blocked due to unresolved safety risk.'
                        };
                    }
                    if (responseLower.includes('to continue, confirm')) {
                        assistantState = 'INTENT_INCOMPLETE';
                        return {
                            status: 'NEEDS_CLARIFICATION',
                            question: response.trim()
                        };
                    }
                    if (
                        responseLower.includes('do you recognize and trust the contract') ||
                        responseLower.includes('token approval or wallet signature') ||
                        responseLower.includes('cannot be reversed')
                    ) {
                        assistantState = 'CLARIFICATION_REQUIRED';
                        return {
                            status: 'NEEDS_CLARIFICATION',
                            question: response.trim()
                        };
                    }
                    console.log('No STATE line found, fallback to CLARIFICATION_REQUIRED');
                    assistantState = 'CLARIFICATION_REQUIRED';
                    message = 'Do you recognize and trust the contract requesting this action?';
                    return {
                        status: 'NEEDS_CLARIFICATION',
                        question: message
                    };
                }
                
                const normalizedState = (() => {
                    if (stateLine.startsWith('STATE:')) {
                        const label = stateLine.replace('STATE:', '').trim().toLowerCase();
                        if (label.includes('intent incomplete')) return 'INTENT_INCOMPLETE';
                        if (label.includes('safety clarification required')) return 'CLARIFICATION_REQUIRED';
                        if (label.includes('ready for execution')) return 'INTENT_VERIFIED';
                        if (label.includes('high risk') || label.includes('block')) return 'EXECUTION_BLOCKED';
                        return label.toUpperCase();
                    }
                    if (stateLine.startsWith('STATE 1')) return 'INTENT_INCOMPLETE';
                    if (stateLine.startsWith('STATE 2')) return 'CLARIFICATION_REQUIRED';
                    if (stateLine.startsWith('STATE 3')) return 'INTENT_VERIFIED';
                    if (stateLine.startsWith('STATE 4')) return 'EXECUTION_BLOCKED';
                    return 'CLARIFICATION_REQUIRED';
                })();
                assistantState = normalizedState;
                console.log('Assistant State:', assistantState);
                
                const stateLineIndex = lines.indexOf(stateLine);
                message = lines.slice(stateLineIndex + 1).join('\n').trim();
                
                if (normalizedState === 'INTENT_INCOMPLETE') {
                    return {
                        status: 'NEEDS_CLARIFICATION',
                        question: message || 'To continue, confirm this one detail: platform or app.'
                    };
                } else if (normalizedState === 'CLARIFICATION_REQUIRED') {
                    return {
                        status: 'NEEDS_CLARIFICATION',
                        question: message
                    };
                } else if (normalizedState === 'EXECUTION_BLOCKED') {
                    return {
                        status: 'BLOCKED',
                        message: message
                    };
                } else if (normalizedState === 'INTENT_VERIFIED') {
                    return { status: 'CLEAR' };
                } else {
                    console.log('Unknown state:', state, 'fallback to CLARIFICATION_REQUIRED');
                    assistantState = 'CLARIFICATION_REQUIRED';
                    return {
                        status: 'NEEDS_CLARIFICATION',
                        question: 'Do you understand the risks of this transaction?'
                    };
                }
            } catch (error) {
                console.error('Detect ambiguity error:', error);
                assistantState = 'CLARIFICATION_REQUIRED';
                return {
                    status: 'NEEDS_CLARIFICATION',
                    question: 'Do you understand the risks of this transaction?'
                };
            }
        }

        // Step 3: Combine Intent with Clarification
        async function combineIntentWithClarification(originalIntent, clarification) {
            const systemPrompt = `You are an AI confirmation assistant for blockchain actions.
Your role is to protect users from executing smart contracts they do not fully understand.

Original intent:
"${originalIntent}"

User clarification:
"${clarification}"

Combine both into a single, clear intent statement.

Rules:
- Do not add new conditions
- Do not remove user intent
- Keep it concise and explicit`;

            try {
                const combined = await callLLM(systemPrompt, 'Combine into one clear statement:');
                return combined.trim();
            } catch (error) {
                console.error('Combine intent error:', error);
                return `${originalIntent} ${clarification}`.trim();
            }
        }

        // Step 4: Confirm Final Intent
        async function confirmFinalIntent(finalIntent) {
            const systemPrompt = `You are an AI confirmation assistant for blockchain actions.

User intent:
"${finalIntent}"

Explain in simple, plain English what will happen if this intent is executed.

Constraints:
- Maximum 3 short sentences
- Do not add assumptions
- Do not introduce new conditions
- Be clear and protective`;

            try {
                const confirmation = await callLLM(systemPrompt, 'Explain what will happen:');
                return confirmation.trim();
            } catch (error) {
                console.error('Confirm intent error:', error);
                return finalIntent;
            }
        }

        // Step 5: Generate Structured JSON
        async function generateExecutionJSON(finalIntent) {
            const systemPrompt = `You are an AI confirmation assistant for blockchain actions.

Convert the following confirmed user intent into a structured execution condition.

User intent:
"${finalIntent}"

Output STRICT JSON with exactly these fields:
- trigger_type (api | time | manual | event)
- data_source (platform name, URL, or "manual")
- condition (short, precise string)
- action (release | refund | notify | lock)
- deadline (ISO 8601 string or null)

Rules:
- Return JSON only
- No explanations
- No extra fields`;

            try {
                const response = await callLLM(systemPrompt, 'Generate JSON:');
                const cleanedResponse = response.replace(/```json|```/g, '').trim();
                return JSON.parse(cleanedResponse);
            } catch (error) {
                console.error('Generate JSON error:', error);
                return {
                    trigger_type: 'event',
                    data_source: 'platform API',
                    condition: 'user_specified_condition',
                    action: 'release',
                    deadline: null
                };
            }
        }

        // Risk Analysis (runs in parallel with JSON generation)
        async function analyzeRisks(finalIntent) {
            const systemPrompt = `You are an AI confirmation assistant for blockchain actions.

Analyze the following intent for potential risks, misunderstandings, or edge cases the user should be aware of before execution.

User intent:
"${finalIntent}"

List up to 2 risks in plain, non-technical language.

Rules:
- Maximum 2 risks
- Use simple language anyone can understand
- Focus on what could go wrong or what the user needs to know
- Be protective but not alarmist`;

            try {
                const response = await callLLM(systemPrompt, 'What risks should the user know about?');
                
                const risks = response
                    .split('\n')
                    .filter(line => line.trim())
                    .map(line => line.replace(/^[-*•]\s*/, '').trim())
                    .filter(line => line.length > 0)
                    .slice(0, 2);
                
                return risks.length > 0 ? risks : ['Please verify all details are correct before proceeding.'];
            } catch (error) {
                console.error('Risk analysis error:', error);
                return ['Once executed, this action cannot be reversed. Please verify all details carefully.'];
            }
        }

        // View Management
        function showView(viewName) {
            try {
                // GUARD CLAUSE: Prevent navigation during clarification submission
                if (appState.CLARIFICATION_SUBMITTED && viewName === 'intent-input-view') {
                    console.warn('Navigation blocked during clarification submission');
                    return;
                }
                
                console.log('Showing view:', viewName);
                
                const views = ['intent-input-view', 'loading-view', 'clarification-view', 'confirmation-view', 'status-view', 'explanation-clarification-view'];
                views.forEach(view => {
                    const element = document.getElementById(view);
                    if (element) {
                        element.classList.add('hidden');
                    } else {
                        console.error('View element not found:', view);
                    }
                });
                
                const targetView = document.getElementById(viewName);
                if (targetView) {
                    targetView.classList.remove('hidden');
                    appState.currentView = viewName;
                    persistState();
                    
                    // Update 3-step progress indicator
                    updateStepIndicator(viewName);
                } else {
                    console.error('Target view not found:', viewName);
                }
            } catch (error) {
                console.error('Error in showView function:', error);
            }
        }
        
        // Update 3-step progress indicator based on current view
        function updateStepIndicator(viewName) {
            const step1 = document.getElementById('step-1');
            const step2 = document.getElementById('step-2');
            const step3 = document.getElementById('step-3');
            const connectorFill = document.getElementById('connector-fill');
            
            if (!step1 || !step2 || !step3) return;
            
            // Reset all steps
            [step1, step2, step3].forEach(step => {
                step.classList.remove('active', 'completed');
                const checkIcon = step.querySelector('.step-check');
                const numText = step.querySelector('.step-num-text');
                if (checkIcon) checkIcon.classList.add('hidden');
                if (numText) numText.style.display = 'block';
            });
            
            // Set appropriate states based on view
            switch(viewName) {
                case 'intent-input-view':
                    step1.classList.add('active');
                    if (connectorFill) connectorFill.style.width = '0%';
                    break;
                case 'clarification-view':
                case 'explanation-clarification-view':
                case 'loading-view':
                    setStepCompleted(step1);
                    step2.classList.add('active');
                    if (connectorFill) connectorFill.style.width = '50%';
                    break;
                case 'confirmation-view':
                    setStepCompleted(step1);
                    setStepCompleted(step2);
                    step3.classList.add('active');
                    if (connectorFill) connectorFill.style.width = '100%';
                    break;
                case 'status-view':
                    setStepCompleted(step1);
                    setStepCompleted(step2);
                    setStepCompleted(step3);
                    if (connectorFill) connectorFill.style.width = '100%';
                    break;
            }
        }
        
        // Helper to set step as completed with checkmark
        function setStepCompleted(stepElement) {
            stepElement.classList.add('completed');
            const checkIcon = stepElement.querySelector('.step-check');
            const numText = stepElement.querySelector('.step-num-text');
            if (checkIcon) checkIcon.classList.remove('hidden');
            if (numText) numText.style.display = 'none';
        }

        // Helper to show errors on clarification page
        function showClarificationError(message) {
            try {
                console.log('Showing clarification error:', message);
                const errorDiv = document.createElement('div');
                errorDiv.className = 'alert-error mb-4';
                errorDiv.innerHTML = `
                    <div class="flex gap-3">
                        <svg class="w-5 h-5 text-red-500 flex-shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                        </svg>
                        <p class="text-sm leading-relaxed">${message}</p>
                    </div>
                `;
                
                // Get the clarification view
                const clarificationView = document.getElementById('clarification-view');
                if (!clarificationView) {
                    console.error('Clarification view not found');
                    return;
                }
                
                // Remove any existing error messages
                const existingErrors = document.querySelectorAll('#clarification-view .alert-error');
                if (existingErrors) {
                    existingErrors.forEach(error => {
                        if (error && error.parentNode) {
                            error.parentNode.removeChild(error);
                        }
                    });
                }
                
                // Find the status badge to insert before
                const firstChild = clarificationView.querySelector('.status-badge');
                if (firstChild) {
                    clarificationView.insertBefore(errorDiv, firstChild);
                } else {
                    // If no status badge is found, just prepend to the clarification view
                    clarificationView.prepend(errorDiv);
                }
                
                // Auto-remove after 5 seconds
                setTimeout(() => {
                    if (errorDiv && errorDiv.parentNode) {
                        errorDiv.parentNode.removeChild(errorDiv);
                    }
                }, 5000);
            } catch (error) {
                console.error('Error showing clarification error:', error);
                // Fallback to alert if there's an error with the DOM manipulation
                alert('Error: ' + message);
            }
        }

        function showExamples() {
            const examplesSection = document.getElementById('examples-section');
            examplesSection.classList.toggle('hidden');
        }

        function useExample(index) {
            document.getElementById('user-intent').value = examples[index];
            document.getElementById('examples-section').classList.add('hidden');
        }

        // ==========================================
        // MAIN FLOW FUNCTIONS - INTENT VERIFICATION
        // ==========================================

        async function analyzeIntent() {
            try {
                console.log('[STATE] analyzeIntent called');
                const userIntentElement = document.getElementById('user-intent');
                
                if (!userIntentElement) {
                    console.error('User intent element not found');
                    alert('An error occurred. Please refresh the page and try again.');
                    return;
                }
                
                const intent = userIntentElement.value.trim();
                
                if (!intent) {
                    alert('Please describe what you want to do.');
                    return;
                }
                
                // Capture intent - STATE 1
                console.log('[STATE] CAPTURE_INTENT:', intent);
                appState.currentStep = 'CAPTURE_INTENT';
                appState.originalIntent = intent;
                appState.interpretedIntent = intent; // Start with original
                appState.clarificationHistory = [];
                appState.intentConfirmed = false;
                appState.awaitingUserAction = true;
                persistState();
                
                showView('loading-view');
                
                // Generate interpretation of the intent
                console.log('[STATE] Generating intent interpretation...');
                const interpretation = await generateIntentInterpretation(intent);
                
                if (!interpretation) {
                    showInterpretationFailed();
                    return;
                }
                
                // Check if clarification is needed
                if (interpretation.needsClarification) {
                    console.log('[STATE] Clarification needed:', interpretation.question);
                    appState.currentStep = 'CLARIFY';
                    appState.awaitingUserAction = true;
                    persistState();
                    showClarificationView(interpretation.question, interpretation.currentInterpretation);
                    return;
                }
                
                // No clarification needed - show interpreted intent for confirmation
                console.log('[STATE] No clarification needed, showing confirmation');
                appState.currentStep = 'CONFIRM_INTENT';
                appState.interpretedIntent = interpretation.interpretation;
                appState.awaitingUserAction = true;
                persistState();
                showIntentConfirmation(interpretation.interpretation);
                
            } catch (error) {
                console.error('Error in analyzeIntent:', error);
                alert('An error occurred. Please try again.');
                showView('intent-input-view');
            }
        }
        
        // Generate interpretation of user intent
        async function generateIntentInterpretation(intent) {
            const systemPrompt = `You are an Intent Interpreter for a smart contract verification system.

Your job: Interpret the user's intent and determine if clarification is needed.

INPUT: "${intent}"

RULES:
- If the intent is clear and complete, provide a plain English interpretation
- If any critical detail is missing (amount, recipient, timing, conditions), ask ONE clarification question
- Do NOT add assumptions - only interpret what is explicitly stated
- Do NOT provide safety warnings or risk analysis

OUTPUT FORMAT (choose one):

If clarification needed:
NEEDS_CLARIFICATION: true
QUESTION: [single clarification question]
CURRENT_INTERPRETATION: [what you understand so far]

If intent is clear:
NEEDS_CLARIFICATION: false
INTERPRETATION: [plain English statement of what will happen]`;

            try {
                const response = await callLLM(systemPrompt, intent);
                return parseInterpretationResponse(response);
            } catch (error) {
                console.error('Interpretation error:', error);
                return null;
            }
        }
        
        function parseInterpretationResponse(response) {
            const lines = response.split('\n').map(l => l.trim()).filter(l => l);
            const result = {
                needsClarification: false,
                question: null,
                currentInterpretation: null,
                interpretation: null
            };
            
            for (const line of lines) {
                if (line.startsWith('NEEDS_CLARIFICATION:')) {
                    result.needsClarification = line.includes('true');
                } else if (line.startsWith('QUESTION:')) {
                    result.question = line.replace('QUESTION:', '').trim();
                } else if (line.startsWith('CURRENT_INTERPRETATION:')) {
                    result.currentInterpretation = line.replace('CURRENT_INTERPRETATION:', '').trim();
                } else if (line.startsWith('INTERPRETATION:')) {
                    result.interpretation = line.replace('INTERPRETATION:', '').trim();
                }
            }
            
            // Fallback: if no structured response, treat as complete interpretation
            if (!result.needsClarification && !result.interpretation) {
                result.interpretation = response.trim();
            }
            
            return result;
        }

        // Submit clarification - updates existing intent, does not replace
        async function submitClarification() {
            try {
                console.log('[STATE] submitClarification called');
                const answerElement = document.getElementById('clarification-answer');
                
                if (!answerElement) {
                    alert('An error occurred. Please refresh.');
                    return;
                }
                
                const answer = answerElement.value.trim();
                if (!answer) {
                    alert('Please provide an answer.');
                    return;
                }
                
                // Record clarification - UPDATE intent, don't replace
                const currentQuestion = document.getElementById('clarification-question')?.textContent || '';
                appState.clarificationHistory.push({ question: currentQuestion, answer: answer });
                
                console.log('[STATE] Clarification recorded:', { question: currentQuestion, answer });
                
                showView('loading-view');
                
                // Generate updated interpretation with clarification
                const updatedInterpretation = await updateIntentWithClarification(
                    appState.originalIntent,
                    appState.clarificationHistory
                );
                
                if (!updatedInterpretation) {
                    showInterpretationFailed();
                    return;
                }
                
                // Check if more clarification needed
                if (updatedInterpretation.needsClarification) {
                    console.log('[STATE] Additional clarification needed');
                    appState.awaitingUserAction = true;
                    persistState();
                    showClarificationView(updatedInterpretation.question, updatedInterpretation.currentInterpretation);
                    return;
                }
                
                // Clarification complete - show final interpretation for confirmation
                console.log('[STATE] Clarification complete, showing confirmation');
                appState.currentStep = 'CONFIRM_INTENT';
                appState.interpretedIntent = updatedInterpretation.interpretation;
                appState.awaitingUserAction = true;
                persistState();
                showIntentConfirmation(updatedInterpretation.interpretation);
                
            } catch (error) {
                console.error('Clarification error:', error);
                alert('An error occurred. Please try again.');
                showView('clarification-view');
            }
        }
        
        // Update intent with clarification answers
        async function updateIntentWithClarification(originalIntent, clarificationHistory) {
            const clarifications = clarificationHistory.map(c => `Q: ${c.question}\nA: ${c.answer}`).join('\n\n');
            
            const systemPrompt = `You are an Intent Interpreter for a smart contract verification system.

ORIGINAL INTENT: "${originalIntent}"

CLARIFICATIONS PROVIDED:
${clarifications}

Your job: Update the interpretation based on the clarifications.

RULES:
- Combine the original intent with the clarification answers
- If still unclear, ask ONE more clarification question
- Do NOT add assumptions beyond what was stated
- Do NOT provide safety warnings

OUTPUT FORMAT (choose one):

If more clarification needed:
NEEDS_CLARIFICATION: true
QUESTION: [single clarification question]
CURRENT_INTERPRETATION: [what you understand so far]

If intent is now clear:
NEEDS_CLARIFICATION: false
INTERPRETATION: [complete plain English statement of what will happen]`;

            try {
                const response = await callLLM(systemPrompt, originalIntent);
                return parseInterpretationResponse(response);
            } catch (error) {
                console.error('Update interpretation error:', error);
                return null;
            }
        }
        
        // Show clarification view
        function showClarificationView(question, currentInterpretation) {
            console.log('[VIEW] Showing clarification view');
            
            const questionEl = document.getElementById('clarification-question');
            const originalIntentEl = document.getElementById('original-intent-display');
            const answerEl = document.getElementById('clarification-answer');
            
            if (questionEl) questionEl.textContent = question;
            if (originalIntentEl) originalIntentEl.textContent = currentInterpretation || appState.originalIntent;
            if (answerEl) answerEl.value = '';
            
            showView('clarification-view');
        }
        
        // Show intent confirmation view - user must explicitly confirm
        function showIntentConfirmation(interpretation) {
            console.log('[VIEW] Showing intent confirmation');
            
            const explanationContainer = document.getElementById('plain-english-explanation');
            if (explanationContainer) {
                explanationContainer.innerHTML = `
                    <div class="card mb-4">
                        <h4 class="text-sm font-medium mb-3 text-cyan-400">We understand your intent as:</h4>
                        <p class="text-base leading-relaxed">${interpretation}</p>
                    </div>
                    <div class="alert-info">
                        <p class="text-sm">Please confirm this is what you want to do before proceeding.</p>
                    </div>
                `;
            }
            
            // Store for execution
            appState.interpretedIntent = interpretation;
            persistState();
            
            showView('confirmation-view');
        }
        
        // Show interpretation failed
        function showInterpretationFailed() {
            console.log('[VIEW] Interpretation failed');
            alert('Unable to interpret your intent. Please try rephrasing.');
            showView('intent-input-view');
        }

        async function showConfirmation() {
            try {
                console.log('Showing confirmation view...');
                showView('loading-view');
                
                if (!appState.finalIntent) {
                    console.error('No final intent available for confirmation');
                    alert('An error occurred. Please try again.');
                    showView('intent-input-view');
                    return;
                }
                
                console.log('Generating plain English explanation...');
                let plainEnglishExplanation;
                try {
                    plainEnglishExplanation = await generatePlainEnglishExplanation(appState.finalIntent);
                    appState.plainEnglishExplanation = plainEnglishExplanation;
                } catch (explanationError) {
                    console.error('Error generating plain English explanation:', explanationError);
                    plainEnglishExplanation = {
                        summary: 'Unable to generate detailed explanation.',
                        whatWillHappen: ['The requested action will be executed.'],
                        whoIsAffected: ['You and any counterparties involved.'],
                        whenWillItHappen: ['Upon confirmation and execution.'],
                        isIncomplete: false
                    };
                    appState.plainEnglishExplanation = plainEnglishExplanation;
                }
                
                if (plainEnglishExplanation && plainEnglishExplanation.isIncomplete) {
                    console.log('Explanation is incomplete, showing clarification...');
                    await showExplanationClarification(plainEnglishExplanation);
                    return;
                }
                
                console.log('Running parallel confirmation tasks...');
                let finalExplanation, executionJSON, risks;
                
                try {
                    [finalExplanation, executionJSON, risks] = await Promise.all([
                        confirmFinalIntent(appState.finalIntent),
                        generateExecutionJSON(appState.finalIntent),
                        analyzeRisks(appState.finalIntent)
                    ]);
                } catch (parallelError) {
                    console.error('Error in parallel confirmation tasks:', parallelError);
                    finalExplanation = finalExplanation || appState.finalIntent;
                    executionJSON = executionJSON || {
                        trigger_type: 'manual',
                        data_source: 'user input',
                        condition: 'user confirmation',
                        action: 'execute',
                        deadline: null
                    };
                    risks = risks || ['Please verify all details before proceeding.'];
                }
                
                appState.executionJSON = executionJSON;
                appState.risks = risks;
                
                const explanationContainer = document.getElementById('plain-english-explanation');
                if (explanationContainer) {
                    try {
                        explanationContainer.innerHTML = renderPlainEnglishExplanation(plainEnglishExplanation);
                    } catch (renderError) {
                        console.error('Error rendering plain English explanation:', renderError);
                        explanationContainer.textContent = 'Unable to display detailed explanation.';
                    }
                } else {
                    console.error('Explanation container not found');
                }
                
                const finalIntentDisplay = document.getElementById('final-intent-display');
                if (finalIntentDisplay) {
                    finalIntentDisplay.textContent = appState.finalIntent;
                } else {
                    console.error('Final intent display element not found');
                }
                
                const risksList = document.getElementById('risks-list');
                if (risksList) {
                    try {
                        risksList.innerHTML = risks.map(risk => 
                            `<li class="risk-warning">
                                <div class="flex gap-3">
                                    <svg class="w-4 h-4 text-yellow-500 flex-shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                                    </svg>
                                    <span class="text-sm leading-relaxed">${risk}</span>
                                </div>
                            </li>`
                        ).join('');
                    } catch (risksError) {
                        console.error('Error rendering risks:', risksError);
                        risksList.innerHTML = '<li class="risk-warning">Please review all details carefully.</li>';
                    }
                } else {
                    console.error('Risks list element not found');
                }
                
                const jsonPreview = document.getElementById('json-preview');
                if (jsonPreview) {
                    try {
                        jsonPreview.textContent = JSON.stringify(executionJSON, null, 2);
                    } catch (jsonError) {
                        console.error('Error stringifying JSON:', jsonError);
                        jsonPreview.textContent = '{"error": "Unable to display technical details"}';
                    }
                } else {
                    console.error('JSON preview element not found');
                }
                
                showView('confirmation-view');
            } catch (error) {
                console.error('Error in showConfirmation function:', error);
                alert('An error occurred while showing confirmation. Please try again.');
                showView('intent-input-view');
            }
        }

        async function showExplanationClarification(incompleteExplanation) {
            const missingSection = incompleteExplanation.missingSections[0];
            const clarificationQuestion = await generateClarificationQuestion(
                missingSection, 
                appState.finalIntent, 
                appState.explanationClarificationHistory.map(c => c.answer)
            );
            
            appState.currentClarificationQuestion = clarificationQuestion;
            appState.currentMissingSection = missingSection;
            
            const explanationContainer = document.getElementById('plain-english-explanation-clarification');
            if (explanationContainer) {
                explanationContainer.innerHTML = renderPlainEnglishExplanation(incompleteExplanation);
            }
            
            document.getElementById('explanation-clarification-question').textContent = clarificationQuestion;
            document.getElementById('clarification-progress').textContent = `Step ${appState.explanationClarificationAttempts + 1} of 2`;
            
            showView('explanation-clarification-view');
        }

        async function submitExplanationClarification() {
            const answer = document.getElementById('explanation-clarification-answer').value.trim();
            
            if (!answer) {
                alert('Please answer the question so we can continue.');
                return;
            }
            
            appState.clarification = answer;
            appState.explanationClarificationHistory.push({
                question: appState.currentClarificationQuestion,
                answer: answer,
                section: appState.currentMissingSection
            });
            
            appState.explanationClarificationAttempts++;
            persistState();
            
            showView('loading-view');
            // Combine original intent + clarification, then re-explain final intent
            const combinedIntent = await combineIntentWithClarification(appState.originalIntent, answer);
            appState.finalIntent = combinedIntent;
            
            const newExplanation = await generatePlainEnglishExplanation(combinedIntent);
            appState.plainEnglishExplanation = newExplanation;
            
            if (!newExplanation || newExplanation.isIncomplete) {
                showExplanationVerificationFailed();
                return;
            }
            
            appState.clarificationCompleted = true;
            appState.lastClarifiedIntent = generateIntentHash(appState.originalIntent);
            await showConfirmation();
        }

        async function completeConfirmationFlow() {
            const [finalExplanation, executionJSON, risks] = await Promise.all([
                confirmFinalIntent(appState.finalIntent),
                generateExecutionJSON(appState.finalIntent),
                analyzeRisks(appState.finalIntent)
            ]);
            
            appState.executionJSON = executionJSON;
            appState.risks = risks;
            
            const explanationContainer = document.getElementById('plain-english-explanation');
            if (explanationContainer) {
                explanationContainer.innerHTML = renderPlainEnglishExplanation(appState.plainEnglishExplanation);
            }
            
            const finalIntentDisplay = document.getElementById('final-intent-display');
            if (finalIntentDisplay) {
                finalIntentDisplay.textContent = finalExplanation;
            }
            
            const risksList = document.getElementById('risks-list');
            if (risksList) {
                risksList.innerHTML = risks.map(risk => 
                    `<li class="risk-warning">
                        <div class="flex gap-3">
                            <svg class="w-4 h-4 text-yellow-500 flex-shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                            </svg>
                            <span class="text-sm leading-relaxed">${risk}</span>
                        </div>
                    </li>`
                ).join('');
            }
            
            const jsonPreview = document.getElementById('json-preview');
            if (jsonPreview) {
                jsonPreview.textContent = JSON.stringify(executionJSON, null, 2);
            }
            
            showView('confirmation-view');
        }
        
        function showExplanationVerificationFailed() {
            const explanationContainer = document.getElementById('plain-english-explanation');
            explanationContainer.innerHTML = `<div class="alert-warning mb-6">
                <div class="flex gap-3">
                    <svg class="w-5 h-5 text-red-500 flex-shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                    </svg>
                    <p class="text-sm leading-relaxed">Unable to verify safely</p>
                </div>
            </div>`;
            
            // Disable confirm button permanently
            const confirmButton = document.querySelector('button[onclick="executeContract()"]');
            confirmButton.disabled = true;
            confirmButton.textContent = 'Verification Failed';
            confirmButton.classList.remove('btn-primary');
            confirmButton.classList.add('btn-secondary');
            
            showView('confirmation-view');
        }

        function showExecutionBlocked(message) {
            // Create execution blocked view content
            const mainContainer = document.getElementById('app-container');
            const blockedContent = `
                <div class="status-badge status-error mb-6">
                    <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                    </svg>
                    <span>Execution Blocked</span>
                </div>

                <div class="alert-error mb-6">
                    <div class="flex gap-3">
                        <svg class="w-5 h-5 text-red-500 flex-shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                        </svg>
                        <div>
                            <p class="text-sm leading-relaxed font-medium mb-2">Safety Check Failed</p>
                            <p class="text-sm leading-relaxed">${message}</p>
                        </div>
                    </div>
                </div>

                <div class="mb-6">
                    <p class="text-sm leading-relaxed opacity-70">
                        This action has been blocked to protect your funds. Please review the safety information above and try again with a clearer description of what you want to do.
                    </p>
                </div>

                <div class="flex gap-3">
                    <button 
                        onclick="resetApp()" 
                        class="btn-primary"
                    >
                        Try Again
                    </button>
                </div>
            `;
            
            mainContainer.innerHTML = blockedContent;
        }

        async function executeContract() {
            // GUARD: Only execute if intent was explicitly confirmed
            if (!appState.intentConfirmed && appState.currentStep !== 'CONFIRM_INTENT') {
                alert('Please confirm your intent before executing.');
                return;
            }
            
            console.log('[STATE] Executing contract with intent:', appState.interpretedIntent);
            appState.currentStep = 'EXECUTE';
            appState.intentConfirmed = true;
            persistState();
            
            showView('loading-view');
            
            // Generate execution JSON only at execution time
            appState.executionJSON = await generateExecutionJSON(appState.interpretedIntent);
            
            // Simulate blockchain execution
            await new Promise(resolve => setTimeout(resolve, 2000));
            
            // Simulate success (you can add random failure for testing)
            const success = Math.random() > 0.1; // 90% success rate
            
            if (success) {
                document.getElementById('success-status').classList.remove('hidden');
                document.getElementById('error-status').classList.add('hidden');
                
                // Generate mock transaction details
                const transactionDetails = document.getElementById('transaction-details');
                transactionDetails.innerHTML = `
                    <div class="text-sm">
                        <div class="flex justify-between py-2 border-b">
                            <span class="text-gray-600">Transaction Hash:</span>
                            <span class="font-mono text-gray-800">0x${Math.random().toString(16).substr(2, 64)}</span>
                        </div>
                        <div class="flex justify-between py-2 border-b">
                            <span class="text-gray-600">Block Number:</span>
                            <span class="font-mono text-gray-800">${Math.floor(Math.random() * 1000000)}</span>
                        </div>
                        <div class="flex justify-between py-2 border-b">
                            <span class="text-gray-600">Gas Used:</span>
                            <span class="font-mono text-gray-800">${Math.floor(Math.random() * 100000)} wei</span>
                        </div>
                        <div class="flex justify-between py-2">
                            <span class="text-gray-600">Status:</span>
                            <span class="text-green-600 font-semibold">Confirmed</span>
                        </div>
                    </div>
                `;
            } else {
                document.getElementById('success-status').classList.add('hidden');
                document.getElementById('error-status').classList.remove('hidden');
                document.getElementById('error-message').textContent = 'We couldn\'t connect to the network. Your funds are safe - nothing was executed.';
                
                const transactionDetails = document.getElementById('transaction-details');
                transactionDetails.innerHTML = `
                    <div class="text-sm text-gray-600">
                        <p class="font-semibold">What happened:</p>
                        <p class="mt-2">The connection to the blockchain network timed out. This is usually temporary.</p>
                        <p class="mt-2">You can try again in a moment, or come back later.</p>
                    </div>
                `;
            }
            
            showView('status-view');
        }

        function resetApp() {
            // Confirm reset if user has made progress
            if (appState.currentStep !== 'CAPTURE_INTENT' && appState.clarificationHistory.length > 0) {
                const confirmReset = confirm('Are you sure you want to start over? Your current progress will be lost.');
                if (!confirmReset) {
                    return;
                }
            }
            
            // Reset to initial state - Intent Verification State Machine
            appState = {
                currentView: 'intent-input',
                currentStep: 'CAPTURE_INTENT',
                originalIntent: '',
                interpretedIntent: '',
                clarificationHistory: [],
                executionJSON: null,
                intentConfirmed: false,
                awaitingUserAction: true
            };
            
            // Reset conversation state
            assistantState = null;
            conversationHistory = [];
            
            // Clear persisted state
            clearPersistedState();
            
            // Clear form inputs
            const userIntent = document.getElementById('user-intent');
            const clarificationAnswer = document.getElementById('clarification-answer');
            const explanationClarificationAnswer = document.getElementById('explanation-clarification-answer');
            const examplesSection = document.getElementById('examples-section');
            
            if (userIntent) userIntent.value = '';
            if (clarificationAnswer) clarificationAnswer.value = '';
            if (explanationClarificationAnswer) explanationClarificationAnswer.value = '';
            if (examplesSection) examplesSection.classList.add('hidden');
            
            console.log('[STATE] App reset to CAPTURE_INTENT');
            showView('intent-input-view');
        }
        
        // ==========================================
        // WALLET/EXTERNAL API INTEGRATION
        // ==========================================
        
        // Allow external apps to consume the explanation as JSON
        function getPlainEnglishExplanationJSON() {
            if (!appState.plainEnglishExplanation) {
                return null;
            }
            
            return {
                whatWillHappen: appState.plainEnglishExplanation.whatWillHappen,
                whoIsAffected: appState.plainEnglishExplanation.whoIsAffected,
                whatCouldGoWrong: appState.plainEnglishExplanation.whatCouldGoWrong,
                whatCannotBeUndone: appState.plainEnglishExplanation.whatCannotBeUndone,
                timestamp: new Date().toISOString(),
                intent: appState.finalIntent
            };
        }
        
        // Global access for wallets/external apps
        window.ContractSafetyAPI = {
            getExplanation: getPlainEnglishExplanationJSON,
            getCurrentIntent: () => appState.finalIntent,
            getExecutionJSON: () => appState.executionJSON
        };

        // Initialize app
        function initializeApp() {
            try {
                console.log('Initializing Transaction Safety App...');
                loadPersistedState();
                
                // Set API status indicator with new pulse element
                const apiStatusIndicator = document.getElementById('api-status');
                if (apiStatusIndicator) {
                    const pulseSpan = apiStatusIndicator.querySelector('.status-pulse');
                    const textSpan = apiStatusIndicator.querySelector('span:last-child');
                    
                    if (USE_MOCK_MODE) {
                        if (pulseSpan) pulseSpan.className = 'status-pulse demo';
                        if (textSpan) textSpan.textContent = 'Demo Mode';
                        apiStatusIndicator.classList.add('status-pending');
                        apiStatusIndicator.classList.remove('status-verified');
                    } else {
                        if (pulseSpan) pulseSpan.className = 'status-pulse connected';
                        if (textSpan) textSpan.textContent = 'Connected';
                        apiStatusIndicator.classList.add('status-verified');
                        apiStatusIndicator.classList.remove('status-pending');
                    }
                }
                
                // Add event listener for clarification submission button
                const submitClarificationBtn = document.getElementById('submit-clarification-btn');
                if (submitClarificationBtn) {
                    submitClarificationBtn.addEventListener('click', function() {
                        submitClarification();
                    });
                }
                
                // Add Enter key handlers for textareas
                const userIntentTextarea = document.getElementById('user-intent');
                if (userIntentTextarea) {
                    userIntentTextarea.addEventListener('keydown', function(e) {
                        if (e.key === 'Enter' && !e.shiftKey) {
                            e.preventDefault();
                            analyzeIntent();
                        }
                    });
                }
                
                const clarificationTextarea = document.getElementById('clarification-answer');
                if (clarificationTextarea) {
                    clarificationTextarea.addEventListener('keydown', function(e) {
                        if (e.key === 'Enter' && !e.shiftKey) {
                            e.preventDefault();
                            submitClarification();
                        }
                    });
                }
                
                const explanationClarificationTextarea = document.getElementById('explanation-clarification-answer');
                if (explanationClarificationTextarea) {
                    explanationClarificationTextarea.addEventListener('keydown', function(e) {
                        if (e.key === 'Enter' && !e.shiftKey) {
                            e.preventDefault();
                            submitExplanationClarification();
                        }
                    });
                }
                
                showView('intent-input-view');
                console.log('App initialized successfully');
            } catch (error) {
                console.error('Error initializing app:', error);
                alert('There was an error initializing the application.');
            }
        }
        
        // Start the app
        initializeApp();