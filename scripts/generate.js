import { GoogleGenAI } from "@google/genai";
import fs from "fs";

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

const today = new Date();
const todayStr = today.toISOString().split("T")[0];
const windowEnd = new Date(today);
windowEnd.setMonth(windowEnd.getMonth() + 12);
const windowEndStr = windowEnd.toISOString().split("T")[0];

const SHARED_RULES = `
GEOGRAPHIC SCOPE: Primarily London and the Midlands (NEC Birmingham, ExCeL, Olympia,
Business Design Centre), plus Manchester (Manchester Central) and Glasgow (Scottish
Event Campus).

TIME WINDOW: Only include events scheduled between ${todayStr} and ${windowEndStr}
(a rolling 12-month horizon from today). Exclude any event that has already taken
place.

QUALIFICATION GATE: Include an event only if it has at least one of: buyer access,
decision-maker access (heads of buying, trading/commercial directors, founders),
significant market intelligence value, significant networking value, or strong
relevance to the sector below. If an event doesn't clear this, either omit it or
include it with classification "ignore" for reference only.

CATEGORIES (pick exactly one per event): "Trade Show", "Awards", "Conference", "Event".

SCORE each event using these five components (integers, each within its own max):
- buyer (0-30): buyer/buying-team access
- decision (0-25): senior decision-maker access (heads of buying, trading/commercial
  directors, founders)
- network (0-20): how much real conversation can happen (awards dinner = high,
  exhibition floor = medium)
- intel (0-15): market/trend intelligence value
- ei (0-10): relevance to the sector below (this is "Enterprise Ireland relevance")

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
- "niche" = small but highly relevant to this sector.
- "monitor" = worth watching, not yet worth active pursuit.
- "ignore" = doesn't meet the qualification gate, kept for reference only.

PRIMARY BENEFIT (pick one dominant purpose, exact string): "Buyer Access",
"Decision Maker Access", "Networking", "Market Intelligence", or "Brand Discovery".

For each event, also write:
- id: a unique lowercase-hyphenated slug for this specific instance
- series: a lowercase-hyphenated slug identifying this event across years (usually
  the same as id, without a year suffix, e.g. "autumn-fair" not "autumn-fair-2026")
- name, location, category, sector (short description of who this is relevant to)
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
      "id": "string", "series": "string", "name": "string",
      "dateStart": "YYYY-MM-DD", "dateEnd": "YYYY-MM-DD", "dateTBC": false,
      "location": "string", "category": "Trade Show", "sector": "string",
      "desc": "string",
      "scores": { "buyer": 0, "decision": 0, "network": 0, "intel": 0, "ei": 0 },
      "classification": "strategic", "confidence": "Medium",
      "primaryBenefit": "Buyer Access", "source": "string",
      "reasons": ["string", "string"], "link": "https://..."
    }
  ]
}

Omit "dateTBC" entirely for confirmed dates. Omit "link" if you don't have one.`;

const SECTORS = [
  {
    name: "Fashion",
    prompt: `SECTOR FOCUS: Fashion retail (womenswear, menswear, accessories, footwear).
VENUES TO CHECK: Olympia London, ExCeL London, Business Design Centre (Islington),
Design Centre Chelsea Harbour, Truman Brewery, Royal Albert Hall, Old Billingsgate.
BODIES & TRADE PRESS TO CHECK (their own events/awards pages by name — awards
ceremonies don't show up on generic exhibitor trackers): British Fashion Council,
Drapers, TheIndustry.fashion, UKFT, Walpole, Clarion Events, Hyve Group.`,
  },
  {
    name: "Homeware & Gift",
    prompt: `SECTOR FOCUS: Homeware and Gift retail (furniture, home accessories, gifting,
tableware, textiles).
VENUES TO CHECK: NEC Birmingham, Cranmore Park (Solihull), Telford International
Centre, Business Design Centre (Islington), Design Centre Chelsea Harbour, Harrogate
Convention Centre.
BODIES & TRADE PRESS TO CHECK: The Giftware Association, AIS (Associated Independent
Stores), BHETA, National Bed Federation, Clarion Events, Hyve Group.`,
  },
  {
    name: "Health & Beauty",
    prompt: `SECTOR FOCUS: Health & Beauty (cosmetics, skincare, haircare, wellness, spa).
VENUES TO CHECK: ExCeL London, Coventry Building Society Arena, Grand Connaught Rooms,
Grosvenor House, Royal Lancaster Hotel, Olympia London.
BODIES & TRADE PRESS TO CHECK: CTPA, CEW UK, COPRA, British Beauty Council, Cosmetics
Business, Society for Cosmetic Science (SCS), Clarion Events, Hyve Group.`,
  },
  {
    name: "Pet",
    prompt: `SECTOR FOCUS: Pet, including pet food.
VENUES TO CHECK: NEC Birmingham, ExCeL London, Olympia London.
BODIES & TRADE PRESS TO CHECK: UK Pet Food, Clarion Events, Hyve Group.`,
  },
  {
    name: "Cross-sector / Manchester & Glasgow regional",
    prompt: `SECTOR FOCUS: Any Fashion, Homeware, Gift, Health & Beauty, or Pet event
specifically based in Manchester or Glasgow (regional venues, not London/Midlands),
plus any major cross-sector retail conference or summit not tied to a single sector
above (e.g. general retail leadership summits relevant to multiple portfolio sectors).
VENUES TO CHECK: Manchester Central Convention Complex, Scottish Event Campus
(Glasgow), V&A South Kensington (London Design Festival hub — cross-sector design
trend event, include if relevant).
BODIES TO CHECK: Clarion Events, Hyve Group, TheIndustry.fashion, TheIndustry.beauty.`,
  },
];

async function fetchSector(sector) {
  const prompt = `You are updating "Opportunity Radar," a monthly briefing on UK
consumer retail trade events for Irish exporters, used for Enterprise Ireland client
support.

${sector.prompt}
${SHARED_RULES}`;

  try {
    const response = await ai.models.generateContent({
      model: "gemini-3.5-flash",
      contents: prompt,
      config: { tools: [{ googleSearch: {} }] },
    });

    let raw = (response.text ?? "").trim();
    raw = raw.replace(/^```json\s*/i, "").replace(/^```\s*/, "").replace(/```$/, "").trim();

    const parsed = JSON.parse(raw);
    if (!parsed.events || !Array.isArray(parsed.events)) {
      console.warn(`[${sector.name}] No 'events' array in response — skipping this sector.`);
      return [];
    }
    console.log(`[${sector.name}] Found ${parsed.events.length} events`);
    return parsed.events;
  } catch (err) {
    console.warn(`[${sector.name}] Failed: ${err.message} — skipping this sector, others continue.`);
    return [];
  }
}

const results = await Promise.all(SECTORS.map(fetchSector));
let allEvents = results.flat();

// De-duplicate: the same flagship event (e.g. Autumn Fair) can legitimately surface
// in more than one sector search. Key on name + start date, case-insensitive.
const seen = new Map();
for (const e of allEvents) {
  const key = `${(e.name || "").toLowerCase().trim()}|${e.dateStart}`;
  if (!seen.has(key)) seen.set(key, e);
}
allEvents = Array.from(seen.values());

if (allEvents.length === 0) {
  throw new Error("All sector searches returned zero events — aborting to avoid overwriting events.json with empty data.");
}

// The script (not the model) owns these metadata fields for consistency.
for (const e of allEvents) {
  e.detected = todayStr;
}

const output = {
  generatedAt: todayStr,
  windowEnd: windowEndStr,
  events: allEvents,
};

fs.writeFileSync("events.json", JSON.stringify(output, null, 2));
console.log(`events.json updated successfully with ${allEvents.length} events (after de-duplication)`);
