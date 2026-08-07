import { GoogleGenAI } from "@google/genai";
import fs from "fs";

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

const prompt = `You are updating "Opportunity Radar," a monthly briefing on UK consumer
retail trade events for Irish exporters, used for Enterprise Ireland client support.

SECTORS COVERED: Fashion, Homeware, Gift, Health & Beauty, Pet (incl. pet food).

GEOGRAPHIC SCOPE: Primarily London and the Midlands (NEC Birmingham, ExCeL, Olympia,
Business Design Centre), plus Manchester (Manchester Central) and Glasgow (Scottish
Event Campus).

SOURCES TO CHECK for event announcements: British Fashion Council, Drapers,
TheIndustry.fashion, TheIndustry.beauty, UKFT, Walpole, The Giftware Association, AIS,
BHETA, CTPA, CEW UK, COPRA, British Beauty Council, Cosmetics Business, National Bed
Federation, Society for Cosmetic Science, UK Pet Food, and organizers Clarion Events
and Hyve Group.

QUALIFICATION GATE: Include an event only if it has at least one of: buyer access,
decision-maker access (heads of buying, trading/commercial directors, founders),
significant market intelligence value, significant networking value, or strong
relevance to the sectors above. Otherwise exclude it (or list under "Ignore" for
reference only).

CATEGORIES (pick one): Trade Show, Awards, Conference, Event.

SCORE each qualifying event 0-100 using these weights:
- Buyer Access 30% (can you meet buyers/buying teams?)
- Decision-Maker Access 25% (can you meet senior decision-makers?)
- Networking Accessibility 20% (can real conversations happen? awards dinner = high,
  exhibition floor = medium)
- Market Intelligence 15% (will you learn about trends/direction?)
- Portfolio Fit 10% (relevance to the sectors above)

CONFIDENCE RATING (separate from score): High (verified attendee/speaker lists,
confirmed retailers, past-edition data), Medium (good indicators, not fully verified),
Low (limited evidence, still worth monitoring). Be honest — most of this is built from
public marketing copy and press coverage, not verified attendance data, so confidence
ratings matter as much as the scores.

CLASSIFICATION (judgment call, not a mechanical score cutoff): Must Attend (core,
unmissable — a flagship event can qualify even with a modest score, e.g. a major
awards ceremony scoring low on buyer access but belonging here for networking/
decision-maker density), Strategic (strong opportunity, solid across most criteria),
Niche (small but highly relevant to a specific sector), Monitor (worth watching, not
yet worth active pursuit), Ignore (doesn't meet the qualification gate).

PRIMARY BENEFIT (pick one dominant purpose): Buyer Access, Decision Maker Access,
Networking, Market Intelligence, Brand Discovery.

TASK: Search for current and upcoming UK trade shows, awards, conferences, and events
in the sectors and regions above. For each qualifying event, determine score,
confidence, classification, and primary benefit per the framework. Then output a
complete, self-contained HTML page (inline CSS, no external dependencies, no
JavaScript needed) titled "Opportunity Radar", with:
- A header showing today's date as "Last updated: <date>"
- Events grouped into sections by classification tier (Must Attend, Strategic, Niche,
  Monitor, Ignore last)
- Each event showing: name, date, venue/city, category, score /100, confidence,
  primary benefit, and a one-sentence rationale
- Clean, readable styling (a simple sans-serif layout is fine)

Return ONLY the raw HTML document, starting with <!DOCTYPE html>. No markdown code
fences, no commentary before or after.`;

const response = await ai.models.generateContent({
  model: "gemini-3.5-flash",
  contents: prompt,
  config: { tools: [{ googleSearch: {} }] },
});

let html = (response.text ?? "").trim();
html = html.replace(/^```html\s*/i, "").replace(/```$/, "").trim();

if (!html.startsWith("<!DOCTYPE") && !html.startsWith("<html")) {
  throw new Error("Gemini did not return valid HTML — aborting to avoid overwriting the live page.");
}

fs.writeFileSync("index.html", html);
console.log("index.html updated successfully");
