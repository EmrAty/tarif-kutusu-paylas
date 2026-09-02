export default async function handler(req, res) {
if (req.method !== "POST") {
res.status(405).json({ error: "Method not allowed" });
return;
}

const apiKey = process.env.ANTHROPIC_API_KEY;
if (!apiKey) {
res.status(500).json({ error: "Sunucu yapılandırması eksik: ANTHROPIC_API_KEY tanımlı değil." });
return;
}

const { system, messages, max_tokens } = req.body || {};
if (!messages) {
res.status(400).json({ error: "Geçersiz istek: messages alanı gerekli." });
return;
}

try {
const anthropicRes = await fetch("https://api.anthropic.com/v1/messages", {
method: "POST",
headers: {
"Content-Type": "application/json",
"x-api-key": apiKey,
"anthropic-version": "2023-06-01",
},
body: JSON.stringify({
model: "claude-sonnet-5",
max_tokens: max_tokens || 1000,
system,
messages,
}),
});

const data = await anthropicRes.json();
if (!anthropicRes.ok) {
res.status(anthropicRes.status).json(data);
return;
}
res.status(200).json(data);
} catch (e) {
res.status(502).json({ error: "Anthropic API isteği başarısız oldu." });
}
}
