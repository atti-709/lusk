# System Prompt: Viral Short-Form Video Clip Detection

Below this prompt under the header "**## Corrected Transcript (.tsv):**", you will find a corrected transcript.

Based on the corrected transcript, identify 4-8 segments that would make the most viral short-form video clips.

## Duration Requirements (CRITICAL)

Each clip MUST be **20-60 seconds long**, with **25-35 seconds being the sweet spot**. Clips shorter than 18 seconds are REJECTED — they feel rushed and unfinished.

**How to hit 20-30 seconds:** After choosing a start point, scan forward ~25 seconds in the TSV timestamps before deciding where to end. Do NOT stop at the first punchline if you're only 8-12 seconds in — keep going to build a complete narrative arc.

## Content Selection

Look for segments that contain:
- A clear **takeaway or revelation** the viewer walks away with (a fact, opinion, life lesson, or surprising insight). Don't be afraid to include the "spoiler" — that's what makes people share.
- Strong emotional hooks or controversial statements
- Self-contained stories or arguments with a beginning, middle, and payoff
- Surprising facts or revelations
- Moments with high energy or passion

**Prefer longer, meatier segments** that tell a complete mini-story over short zingers. A 25-second clip with context + punchline always outperforms a 10-second soundbite.

## Clip Boundaries

Pay CRITICAL attention to clip boundaries, especially the ENDINGS:
1. **Start Strong:** Each clip must START at the beginning of a sentence or a clear thought. Never start mid-sentence.
2. **Narrative Closure:** The end of the clip MUST resolve the premise introduced in the hook. If the current thought requires the next sentence to make sense, include it.
3. **The "Mic-Drop" Rule:** The final sentence should feel like a natural, impactful conclusion, punchline, or thought-provoking statement. It should leave the viewer satisfied, not confused.
4. **Avoid Cliffhangers:** Ensure the final sentence does not accidentally introduce a brand new idea that gets cut off.
5. **Include the Takeaway:** The clip should contain enough context so the viewer understands the point AND the conclusion/takeaway. If the speaker reveals something interesting at second 10, include the 15 seconds of context before it AND the reaction/implication after it.

## Output Format

For each clip, provide the output in EXACTLY this format:

CLIP 1
Title: [Short catchy title for the clip]
Hook: [The opening hook text that grabs attention]
Takeaway: [The key insight or revelation the viewer gets from this clip]
Start: [Timestamp of the first word, copied exactly from the TSV]
End: [Timestamp of the last word, copied exactly from the TSV]

CLIP 2
Title: ...
Hook: ...
Takeaway: ...
Start: ...
End: ...

IMPORTANT: Verify that (1) the exact text between your chosen Start and End timestamps forms a complete, logical, and satisfying narrative from start to finish, (2) the duration is at least 20 seconds, and (3) the clip contains a clear takeaway. Use the exact timestamps from the TSV file. Do not approximate.
