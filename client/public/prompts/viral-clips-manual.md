# Task: Viral Short-Form Video Clip Detection

I will provide a corrected transcript (.tsv) below.

Based on the corrected transcript, identify 12-16 segments that would make the most viral short-form video clips. Mine the whole transcript, not just the first third — cover distinct topics, stories, and standout lines. Each clip is a **single contiguous range** — one start, one end. Never stitch or reorder parts of the transcript.

## Duration Requirements (CRITICAL)

Each clip MUST be **10-30 seconds long**, with **15-25 seconds being the sweet spot**. Clips shorter than 10 seconds or longer than 30 seconds are REJECTED — shorter clips feel rushed and unfinished, longer clips lose viewer retention on Instagram Reels.

**How to hit 15-25 seconds:** After choosing a start point, scan forward ~20 seconds in the TSV timestamps before deciding where to end. Do NOT stop at the first punchline if you're only 5 seconds in — keep going to build a complete narrative arc. But do NOT pad beyond the natural conclusion just to fill time.

## Content Selection

Look for segments that contain:
- A clear **takeaway or revelation** the viewer walks away with (a fact, opinion, life lesson, or surprising insight). Don't be afraid to include the "spoiler" — that's what makes people share.
- Strong emotional hooks or controversial statements
- Self-contained stories or arguments with a beginning, middle, and payoff
- Surprising facts or revelations
- Moments with high energy or passion

**Prefer complete segments** that tell a mini-story over short zingers. A 20-second clip with context + punchline always outperforms a 5-second soundbite.

## Clip Boundaries — CUT ONLY AT SENTENCE ENDS (THE #1 RULE)

The single most important rule: **every clip must begin at the first word of a sentence and end at the last word of a sentence.** A clip that starts or ends mid-sentence is REJECTED no matter how good the content — mid-sentence cuts produce jarring audio jumps and dangling grammar.

- **Start:** copy the timestamp of the first word of your opening sentence. The word right before it in the TSV must end in `.`, `!`, or `?` (or it's the first word of the transcript).
- **End:** find the word that ends your closing sentence (ends in `.`, `!`, or `?`) and use the NEXT word's timestamp so the closing word plays in full.
- **Self-check:** read the words between start and end — they must begin a fresh thought and end on a completed sentence.

On top of the boundary rule:
1. **Start Strong:** Open on a sentence that hooks — a bold claim, question, or surprising setup. Never open on throat-clearing.
2. **Narrative Closure:** The end MUST resolve the premise introduced in the hook. If the current thought requires the next sentence to make sense, include it (and end on ITS sentence boundary).
3. **The "Mic-Drop" Rule:** The final sentence should feel like a natural, impactful conclusion, punchline, or thought-provoking statement. It should leave the viewer satisfied, not confused.
4. **Avoid Cliffhangers:** Ensure the final sentence does not accidentally introduce a brand new idea that gets cut off.
5. **Include the Takeaway:** The clip should contain enough context so the viewer understands the point AND the conclusion/takeaway. If the speaker reveals something interesting at second 10, include the context before it AND the reaction/implication after it.

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

IMPORTANT: Verify that (1) Start is a sentence boundary — the word before it ends in `.`, `!`, or `?` (or it's the first word), (2) End is a sentence boundary — taken from the next word right after a word ending in `.`, `!`, or `?`, (3) the exact text between Start and End forms a complete, logical, satisfying narrative that begins and ends on whole sentences, (4) the duration is between 10-30 seconds, and (5) the clip contains a clear takeaway. Use the exact timestamps from the TSV file. Do not approximate.
