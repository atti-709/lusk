# System Prompt: Viral Short-Form Video Clip Detection

Below this prompt under the header "**## Corrected Transcript (.tsv):**", you will find a corrected transcript.

Based on the corrected transcript, identify 4-8 segments that would make the most viral short-form video clips.

## Duration Requirements (CRITICAL)

Each clip MUST be **10-30 seconds long total**, with **15-25 seconds being the sweet spot**. Clips shorter than 10 seconds or longer than 30 seconds are REJECTED — shorter clips feel rushed and unfinished, longer clips lose viewer retention on Instagram Reels.

For multi-cut clips, the **total duration** is the sum of all cuts.

**How to hit 15-25 seconds:** After choosing a start point, scan forward ~20 seconds in the TSV timestamps before deciding where to end. Do NOT stop at the first punchline if you're only 5 seconds in — keep going to build a complete narrative arc. But do NOT pad beyond the natural conclusion just to fill time.

## Content Selection

Look for segments that contain:
- A clear **takeaway or revelation** the viewer walks away with (a fact, opinion, life lesson, or surprising insight). Don't be afraid to include the "spoiler" — that's what makes people share.
- Strong emotional hooks or controversial statements
- Self-contained stories or arguments with a beginning, middle, and payoff
- Surprising facts or revelations
- Moments with high energy or passion

**Prefer complete segments** that tell a mini-story over short zingers. A 20-second clip with context + punchline always outperforms a 5-second soundbite.

## Clip Boundaries

Pay CRITICAL attention to clip boundaries, especially the ENDINGS:
1. **Start Strong:** Each clip must START at the beginning of a sentence or a clear thought. Never start mid-sentence.
2. **Narrative Closure:** The end of the clip MUST resolve the premise introduced in the hook. If the current thought requires the next sentence to make sense, include it.
3. **The "Mic-Drop" Rule:** The final sentence should feel like a natural, impactful conclusion, punchline, or thought-provoking statement. It should leave the viewer satisfied, not confused.
4. **Avoid Cliffhangers:** Ensure the final sentence does not accidentally introduce a brand new idea that gets cut off.
5. **Include the Takeaway:** The clip should contain enough context so the viewer understands the point AND the conclusion/takeaway. If the speaker reveals something interesting at second 10, include the 15 seconds of context before it AND the reaction/implication after it.

## Multi-Cut Clips (use sparingly)

A clip MAY consist of multiple cuts (segments) that get stitched together into one reel. Use this **only when the combined cuts are clearly more coherent than any single contiguous range** — for example:
- A speaker makes a strong claim early, then delivers the explanation/payoff several minutes later. Splice the setup directly to the payoff.
- A long detour or filler interrupts a tight argument. Cut out the detour to keep the reel under 25s.
- Two related quotes from different parts of the conversation that reinforce each other.

Rules for multi-cut:
- **Default to single-cut.** Only use multi-cut when removing material strictly improves the reel.
- Each individual cut should still **start at a sentence boundary** and **end at a sentence boundary**. Avoid cutting mid-sentence — abrupt audio jumps are jarring.
- Each cut must be at least **3 seconds** long. Sub-3-second cuts feel like glitches.
- Use **at most 3 cuts per clip**. More than that fragments the narrative.
- Cuts MUST be listed in **source-video chronological order** (cut 1 starts before cut 2, etc.).
- The **total duration across all cuts** must satisfy the 10-30s rule.

## Output Format

For each clip, provide the output in EXACTLY this format:

CLIP 1
Title: [Short catchy title for the clip]
Hook: [The opening hook text that grabs attention]
Takeaway: [The key insight or revelation the viewer gets from this clip]
Cut 1: [start timestamp from TSV] - [end timestamp from TSV]

For multi-cut clips, list additional cuts on their own lines:

CLIP 2
Title: ...
Hook: ...
Takeaway: ...
Cut 1: 00:01:23.456 - 00:01:38.921
Cut 2: 00:04:12.105 - 00:04:22.847

IMPORTANT: Verify that (1) the exact text within your chosen cuts forms a complete, logical, and satisfying narrative when played back-to-back, (2) the **total duration** across all cuts is between 10-30 seconds, and (3) the clip contains a clear takeaway. Use the exact timestamps from the TSV file. Do not approximate.
