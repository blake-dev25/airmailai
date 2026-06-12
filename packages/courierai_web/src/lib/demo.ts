import type { CourierAIMessage } from '@courierai/shared';
import type { Chat } from './types';

interface DemoConfig {
    providerId: string;
    modelId: string;
    temperature: number;
    maxTokens: number;
    thinkingLevel: string;
    adaptiveThinking: boolean;
    webSearch: boolean;
    webFetch: boolean;
    codeExecution: boolean;
}

const eggsBenedict =
    "Classic eggs benedict - here's the rundown:\n\n" +
    '## Hollandaise sauce\n' +
    '- 3 egg yolks\n' +
    '- 1 tbsp fresh lemon juice\n' +
    '- 1/2 cup butter, melted and hot\n' +
    '- pinch of salt and cayenne\n\n' +
    "Whisk the yolks and lemon juice in a heatproof bowl set over barely-simmering water - the bowl shouldn't touch the water. Stream in the hot butter slowly while whisking constantly, until it thickens enough to coat a spoon. Season and keep warm off the heat.\n\n" +
    '## Poached eggs\n' +
    '- 4 fresh eggs\n' +
    '- splash of white vinegar\n\n' +
    'Bring a wide pot of water to a bare simmer and add the vinegar. Crack each egg into a small cup, then slide it gently into the water. Poach for 3 minutes for a runny yolk, then lift out with a slotted spoon onto a paper towel.\n\n' +
    '## Assembly\n' +
    '1. Toast 2 English muffins (4 halves) until golden.\n' +
    '2. Sear 4 slices of Canadian bacon or thick ham in a dry skillet, about a minute per side.\n' +
    '3. Stack each half: muffin -> bacon -> poached egg -> generous spoon of hollandaise.\n' +
    '4. Garnish with chopped chives or a dusting of paprika.\n\n' +
    'Serve right away - hollandaise breaks if it sits too long.';

const fizzbuzz =
    "sure! here's your script:\n\n" +
    '```python\n' +
    'for i in range(1, 101):\n' +
    '    if i % 15 == 0:\n' +
    '        print("FizzBuzz")\n' +
    '    elif i % 3 == 0:\n' +
    '        print("Fizz")\n' +
    '    elif i % 5 == 0:\n' +
    '        print("Buzz")\n' +
    '    else:\n' +
    '        print(i)\n' +
    '```';

const moduloExplanation =
    'Sure! `%` is the modulo (remainder) operator - `a % b` gives the remainder when `a` is divided by `b`.\n\n' +
    'A few examples:\n' +
    '- `15 % 5` -> 0 (15 divides evenly by 5)\n' +
    '- `7 % 3` -> 1 (7 / 3 is 2 remainder 1)\n' +
    '- `10 % 3` -> 1\n\n' +
    'So `i % 15 == 0` is true exactly when `i` is a multiple of 15 - i.e. divisible by *both* 3 and 5. That\'s why we check it **first**: otherwise multiples of 15 would match the `% 3` branch and print "Fizz", and we\'d never reach the FizzBuzz case.\n\n' +
    'Rule of thumb: check the most specific condition first, then fall back to the more general ones.';

const skyBlue =
    'Short answer: **Rayleigh scattering**.\n\n' +
    'Sunlight is a mix of all visible wavelengths. When it hits the atmosphere, it bumps into nitrogen and oxygen molecules - but shorter wavelengths (blue, violet) scatter much more than longer ones (red, orange). Scattering goes as 1/wavelength^4^, so blue light (~450 nm) scatters about 5-6x more than red light (~700 nm).\n\n' +
    "When you look up at the daytime sky, you're seeing that scattered blue light coming at your eyes from every direction.\n\n" +
    'A few related things that fall out of this:\n' +
    '- **Sunsets are red** because at low sun angles the light travels through far more atmosphere, so most of the blue scatters away before it reaches you, leaving the longer reds and oranges.\n' +
    '- **The sky should technically look violet** since violet scatters even more than blue - but our eyes are less sensitive to violet, and the sun emits more blue than violet to begin with.\n' +
    '- **On Mars the daytime sky is butterscotch-tan** and turns blue near sunset, because dust scatters light differently than gas molecules do.';

function userMsg(
    id: string,
    createdAt: number,
    text: string
): CourierAIMessage {
    return {
        id,
        role: 'user',
        parts: [{ type: 'text', text, state: 'done' }],
        metadata: { createdAt },
    };
}

function assistantMsg(
    id: string,
    createdAt: number,
    text: string
): CourierAIMessage {
    return {
        id,
        role: 'assistant',
        parts: [{ type: 'text', text, state: 'done' }],
        metadata: { createdAt },
    };
}

export function buildDemoChats(config: DemoConfig): Chat[] {
    const now = Date.now();
    const id = () => crypto.randomUUID();
    let tick = 0;
    const next = () => now + tick++;
    return [
        {
            id: 'demo-1',
            title: 'this is a demo conversation',
            messages: [
                userMsg(id(), next(), 'this is a demo conversation'),
                assistantMsg(id(), next(), 'great! how can I help you?'),
                userMsg(id(), next(), 'give me a recipe for eggs benedict'),
                assistantMsg(id(), next(), eggsBenedict),
            ],
            createdAt: now,
            systemPrompt: '',
            ...config,
        },
        {
            id: 'demo-2',
            title: 'write me a python fizzbuzz script',
            messages: [
                userMsg(id(), next(), 'write me a python fizzbuzz script'),
                assistantMsg(id(), next(), fizzbuzz),
                userMsg(
                    id(),
                    next(),
                    'can you explain how the % operator works there?'
                ),
                assistantMsg(id(), next(), moduloExplanation),
            ],
            createdAt: now - 1000,
            systemPrompt: '',
            ...config,
        },
        {
            id: 'demo-3',
            title: 'why is the sky blue?',
            messages: [
                userMsg(id(), next(), 'why is the sky blue?'),
                assistantMsg(id(), next(), skyBlue),
            ],
            createdAt: now - 2000,
            systemPrompt: '',
            ...config,
        },
    ];
}
