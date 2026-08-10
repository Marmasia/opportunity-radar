import { GoogleGenAI } from "@google/genai";
import fs from "fs";

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

const today = new Date();
const todayStr = today.toISOString().split("T")[0];
const windowEnd = new Date(today);
windowEnd.setMonth(windowEnd.getMonth() + 12);
const windowEndStr = windowEnd.toISOString().split("T")[0];

const prompt = `You are updating "Opportunity Radar," a monthly briefing on UK consumer
retail trade events for Irish exporters, used for Enterprise Ireland client support.

SECTORS COVERED: Fashion, Homeware, Gift, Health & Beauty, Pet (incl. pet food).

GEOGRAPHIC SCOPE: Primarily London and the Midlands (NEC Birmingham, ExCeL, Olympia,
Business Design Centre), plus Manchester (Manchester Central) and Glasgow (Scottish
Event Campus).

TIME WINDOW: Only include events scheduled between ${todayStr} and ${windowEndStr}
(a rolling 12-month horizon from today). Exclude any event that has already taken
place.

VENUES TO CHECK DIRECTLY (many debut/new shows aren't indexed by aggregators yet —
check each venue's own "what's on" page): Business Design Centre (Islington), Coventry
Building Society Arena, Cranmore Park (Solihull), Design Centre Chelsea Harbour, ExCeL
London, Farnborough International, Grand Connaught Rooms, Grosvenor House, Harrogate
Convention Centre, Manchester Central Convention Complex, NEC Birmingham, Old
Billingsgate, Olympia London, Royal Albert Hall, Royal Lancaster Hotel, Scottish Event
Campus (Glasgow), Telford International Centre, Truman Brewery, V&A South Kensington.

BODIES & TRADE PRESS TO CHECK (check each one's own events/awards pages by name —
awards ceremonies especially don't show up on generic exhibitor trackers): AIS
(Associated Independent Stores), BHETA, British Beauty Council, British Fashion
Council, CEW UK, Clarion Events, COPRA, Cosmetics Business, CTPA, Drapers, National
Bed Federation, Society for Cosmetic Science (SCS), The Giftware Association,
TheIndustry.fashion, TheIndustry.beauty, UK Pet Food, UKFT, Walpole, Hyve Group.

QUALIFICATION GATE: Include an event only if it has at least one of: buyer access,
decision-maker access (heads of buying, trading/commercial directors, founders),
significant market intelligence value, significant networking value, or strong
relevance to the sectors above. If an event doesn't clear this, either omit it or
include it with classification "ignore" for reference only.

CATEGORIES (pick exactly one per event): "Trade Show", "Awards", "Conference", "Event".

SCORE each event using these five components (integers, each within its own max):
- buyer (0-30): buyer/buying-team access
- decision (0-25): senior decision-maker access (heads of buying, trading/commercial
  directors, founders)
- network (0-20): how much real conversation can happen (awards dinner = high,
  exhibition floor = medium)
- intel (0-15): market/trend intelligence value
- ei (0-10): relevance to the sectors above (this is "Enterprise Ireland relevance")

CONFIDENCE (exactly one of "High", "Medium", "Low"): High = verified attendee/speaker
lists, confirmed named retailers, or solid past-edition data. Medium = good
indicators, not fully verified. Low = limited evidence, still worth monitoring. Be
honest — most of this is built from public marketing copy and press coverage, not
verified attendance data.

CLASSIFICATION (exactly one of these lowercase keys — a judgment call, not a
mechanical score cutoff):
- "anchor" = Must Attend: core, unmissable. A flagship event can qualify even with a
  modest score (e.g. a major awards ceremony scoring low on buyer access but
  belonging here for networking/decision-maker density).
- "strategic" = strong opportunity, solid across most criteria.
- "niche" = small but highly relevant to a specific sector.
- "monitor" = worth watching, not yet worth active pursuit.
- "ignore" = doesn't meet the qualification gate, kept for reference only.

PRIMARY BENEFIT (pick one dominant purpose, exact string): "Buyer Access",
"Decision Maker Access", "Networking", "Market Intelligence", or "Brand Discovery".

For each event, also write:
- id: a unique lowercase-hyphenated slug for this specific instance
- series: a lowercase-hyphenated slug identifying this event across years (usually
  the same as id, without a year suffix, so recurring editions can be tracked over
  time e.g. "autumn-fair" not "autumn-fair-2026")
- name, location, category, sector (short description of who this is relevant to,
  e.g. "Fashion — Womenswear, Menswear, Accessories")
- desc: one to three sentences, factual, no marketing fluff
- dateStart, dateEnd: ISO format YYYY-MM-DD. If a date isn't confirmed yet, use your
  best estimate based on past editions and set dateTBC: true
- source: which body/venue/search you found this via
- reasons: an array of 2-4 short strings explaining why it was scored/classified this
  way
- link: the event's official URL if you have one, otherwise omit this field

Return ONLY a single valid JSON object, no markdown code fences, no commentary,
matching exactly this shape:

{
  "events": [
    {
      "id": "string",
      "series": "string",
      "name": "string",
      "dateStart": "YYYY-MM-DD",
      "dateEnd": "YYYY-MM-DD",
      "dateTBC": false,
      "location": "string",
      "category": "Trade Show",
      "sector": "string",
      "desc": "string",
      "scores": { "buyer": 0, "decision": 0, "network": 0, "intel": 0, "ei": 0 },
      "classification": "strategic",
      "confidence": "Medium",
      "primaryBenefit": "Buyer Access",
      "source": "string",
      "reasons": ["string", "string"],
      "link": "https://..."
    }
  ]
}

Omit "dateTBC" entirely for confirmed dates. Omit "link" if you don't have one.`;

const response = await ai.models.generateContent({
  model: "gemini-3.5-flash",
  contents: prompt,
  config: { tools: [{ googleSearch: {} }] },
});

let raw = (response.text ?? "").trim();
raw = raw.replace(/^```json\s*/i, "").replace(/^```\s*/, "").replace(/```$/, "").trim();

let parsed;
try {
  parsed = JSON.parse(raw);
} catch (err) {
  console.error("Gemini did not return valid JSON. Raw output was:");
  console.error(raw);
  throw new Error("Aborting — could not parse JSON, leaving events.json untouched.");
}

if (!parsed.events || !Array.isArray(parsed.events)) {
  throw new Error("Parsed JSON has no 'events' array — aborting to avoid overwriting the live data.");
}

// The script (not the model) owns these metadata fields for consistency.
for (const e of parsed.events) {
  e.detected = todayStr;
}

const output = {
  generatedAt: todayStr,
  windowEnd: windowEndStr,
  events: parsed.events,
};

fs.writeFileSync("events.json", JSON.stringify(output, null, 2));
console.log(`events.json updated successfully with ${parsed.events.length} events`);
