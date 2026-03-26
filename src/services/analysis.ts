const ANTHROPIC_URL = "/anthropic-api/v1/messages";
const API_KEY = import.meta.env.VITE_ANTHROPIC_API_KEY as string;

export interface ResponseSuggestion {
  original: string;
  suggested: string;
  reason: string;
}

export interface ConversationAnalysis {
  sentiment: "positive" | "neutral" | "negative";
  sentiment_score: number;
  customer_mood: string;
  resolution_status: "resolved" | "unresolved" | "needs_follow_up";
  topics: string[];
  agent_feedback: string[];
  response_suggestions: ResponseSuggestion[];
  summary: string;
}

export async function analyzeConversation(
  messages: any[]
): Promise<ConversationAnalysis | null> {
  const transcript = messages
    .filter((m) => m.type === "text" || m.type === "note")
    .map((m) => {
      const time = new Date(m.timestamp).toLocaleString();
      if (m.type === "note") {
        const author = m.user?.nickname || "Agent";
        return `[${time}] [Internal Note by ${author}]: ${m.content}`;
      }
      const sender = m.from === "user" ? "Customer" : "Agent";
      return `[${time}] ${sender}: ${m.content}`;
    })
    .join("\n");

  const response = await fetch(ANTHROPIC_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": API_KEY,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: 2048,
      messages: [
        {
          role: "user",
          content: `You are analyzing a customer service conversation from a Shopify app called Pop Convert.

The conversation below may contain MULTIPLE separate interactions over days, weeks, or even months. Your job is to identify and analyze ONLY the most recent interaction/session — i.e. the last time the customer reached out and had an exchange with an agent. Use the timestamps to determine where the most recent interaction begins (look for a significant time gap before it).

Respond with valid JSON only, no markdown fences. Use this exact structure:
{
  "sentiment": "positive" | "neutral" | "negative",
  "sentiment_score": <number from -1.0 to 1.0>,
  "customer_mood": "<one or two words: e.g. happy, frustrated, confused, satisfied, angry, grateful>",
  "resolution_status": "resolved" | "unresolved" | "needs_follow_up",
  "topics": ["<topic1>", "<topic2>"],
  "agent_feedback": ["<actionable suggestion 1>", "<actionable suggestion 2>"],
  "response_suggestions": [
    {
      "original": "<what the agent actually said — quote the key part, keep it short>",
      "suggested": "<a better version of the response>",
      "reason": "<why the suggested version is better>"
    }
  ],
  "summary": "<2-3 sentence summary of the most recent interaction>"
}

For agent_feedback, provide specific, constructive suggestions for how the agent could improve. If the agent did well, say so. Be honest but fair.

Internal notes (marked [Internal Note]) are private messages between agents — the customer never sees them. Use these for additional context about the situation. If a note flags something the agent missed or should have acted on, factor that into your feedback.

For response_suggestions, identify moments where the agent's response could have been meaningfully better — e.g. dismissive, unclear, missed an opportunity to help further, or could have been more empathetic. Show what a stronger response would look like. Only include suggestions where there's a clear improvement to be made — if the agent handled it well, return an empty array. Limit to the 3 most impactful moments.

Here is the full conversation transcript:

${transcript}`,
        },
      ],
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    console.error(`Anthropic API error ${response.status}:`, body);
    return null;
  }

  const json = await response.json();
  const text = json.content?.[0]?.text;
  if (!text) return null;

  try {
    return JSON.parse(text) as ConversationAnalysis;
  } catch {
    console.error("Failed to parse analysis response:", text);
    return null;
  }
}
