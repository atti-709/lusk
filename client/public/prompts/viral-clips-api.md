# System Prompt: Viral Short-Form Video Clip Detection

Below this prompt under the header "**## Corrected Transcript (.tsv):**", you will find a corrected transcript.

Based on the corrected transcript, produce **two groups** of viral short-form video clips:

1. **6 single-cut clips** — the strongest contiguous moments, each a self-contained reel.
2. **2-3 multi-cut clips** — experimental assemblies that stitch 2-3 ranges of the transcript into one reel. These are REQUIRED, not optional. Even if a multi-cut feels weaker than a single-cut, include your best attempts so the editor can review them. Aim for non-trivial multi-cut ideas (delayed payoff, cutting a filler tangent, two reinforcing quotes from far-apart parts of the conversation). Do NOT make a multi-cut just by joining two random adjacent segments — there must be a reason.

Total output: **8-9 clips**.

## Duration Requirements (CRITICAL)

Each clip MUST be **20-30 seconds long total**. Clips shorter than 20 seconds or longer than 30 seconds are REJECTED — shorter clips feel rushed and unfinished, longer clips lose viewer retention on Instagram Reels.

For multi-cut clips, the **total duration** is the sum of all cuts.

**Compute total duration before submitting.** Subtract the start timestamp from the end timestamp of every cut in the clip and add them up. If the total is below 20s or above 30s, REWORK the clip — extend or trim until it fits. Do not submit a clip that fails this check.

**How to hit 20-30 seconds:** After choosing a start point, scan forward ~25 seconds in the TSV timestamps before deciding where to end. Do NOT stop at the first punchline if you're only 5-10 seconds in — keep going to build a complete narrative arc. But do NOT pad beyond the natural conclusion just to fill time; if the natural conclusion lands at 18s, find a different start point that gives you more runway.

## Content Selection

Look for segments that contain:
- A clear **takeaway or revelation** the viewer walks away with (a fact, opinion, life lesson, or surprising insight). Don't be afraid to include the "spoiler" — that's what makes people share.
- Strong emotional hooks or controversial statements
- Self-contained stories or arguments with a beginning, middle, and payoff
- Surprising facts or revelations
- Moments with high energy or passion

**Prefer complete segments** that tell a mini-story over short zingers. A 20-second clip with context + punchline always outperforms a 5-second soundbite.

## Clip Boundaries (CRITICAL — applies to every cut, single AND multi)

**Every cut in every clip must begin AND end on a sentence boundary.** The transcript is provided word-by-word with timestamps. A sentence boundary is the position between a word that ends in `.`, `!`, or `?` and the next word.

How to choose timestamps:
- **Start timestamp:** copy the timestamp of the FIRST word of a sentence. The previous word in the transcript MUST end with `.`, `!`, or `?` (or your chosen word is the very first word in the transcript).
- **End timestamp:** copy the timestamp of the word that ends the sentence (the word ending in `.`, `!`, or `?`). Look ahead in the TSV to the NEXT word's timestamp and use *that* as your end (so the last word's audio plays in full).

**Never** pick a start or end that lands in the middle of a sentence. Mid-sentence cuts produce jarring audio jumps and missing context, and they will be rejected.

Other boundary rules:
1. **Narrative Closure:** The end of the clip MUST resolve the premise introduced in the hook. If the current thought requires the next sentence to make sense, include it.
2. **The "Mic-Drop" Rule:** The final sentence should feel like a natural, impactful conclusion, punchline, or thought-provoking statement. It should leave the viewer satisfied, not confused.
3. **Avoid Cliffhangers:** Ensure the final sentence does not accidentally introduce a brand new idea that gets cut off.
4. **Include the Takeaway:** The clip should contain enough context so the viewer understands the point AND the conclusion/takeaway. If the speaker reveals something interesting at second 10, include the 15 seconds of context before it AND the reaction/implication after it.

### Examples

Suppose the TSV contains:
```
00:01:10.200  Včera
00:01:10.480  som
00:01:10.720  šiel
00:01:10.980  do
00:01:11.220  obchodu.
00:01:11.640  Bolo
00:01:11.880  to
00:01:12.100  hrozné.
00:01:12.500  Ľudia
00:01:12.760  všade.
```

✅ **GOOD cut:** `00:01:10.200 - 00:01:12.500` — starts at the first word of "Včera som šiel do obchodu." and ends at the boundary right after "hrozné." (the next word's timestamp).

❌ **BAD cut:** `00:01:10.720 - 00:01:11.880` — starts mid-sentence ("šiel do obchodu.") and ends mid-sentence ("Bolo to").

❌ **BAD cut:** `00:01:11.220 - 00:01:12.100` — starts on the last word of one sentence and ends mid-sentence.

## Multi-Cut Clips (the 2-3 required ones)

A multi-cut clip stitches 2-3 ranges of the transcript into a single reel. The job is to find combinations that are **more coherent or punchier than any single contiguous range** could be. Concrete patterns to look for:
- **Setup + delayed payoff:** the speaker plants a hook early (a question, a bold claim) and delivers the answer/punchline minutes later. Splice the setup directly onto the payoff.
- **Cut the filler:** a tight argument or story is interrupted by a long tangent or self-correction. Remove the tangent so the reel stays under 25s.
- **Compound testimony:** two distinct moments where the speaker makes the same point in different words — combining them lands harder than either alone.
- **Question + answer across exchanges:** a question asked in one part, the most direct answer given much later.

Rules for every multi-cut:
- Each individual cut MUST start AND end on a sentence boundary (see the "Clip Boundaries" section above — same rules, applied per cut). This is even more critical for multi-cut: any mid-sentence cut produces an obvious audio jump where the splice happens.
- Each cut must be at least **5 seconds** long. Cuts shorter than 5 seconds feel like glitches once spliced.
- Use **2 or 3 cuts per clip** (never more).
- Cuts MUST be listed in **source-video chronological order** (cut 1 starts before cut 2, etc.).
- The **total duration across all cuts** must satisfy the 20-30s rule.
- Cuts must come from **distinct parts of the transcript** — don't list two adjacent ranges where one continuous range would do the same job.

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

**Order in the output:** list the 6 single-cut clips first, then the 2-3 multi-cut clips. Multi-cut clips must have **2 or 3 `Cut N:` lines**; single-cut clips must have exactly **1 `Cut 1:` line**.

IMPORTANT: Before submitting, verify EACH clip against this checklist:
1. You have produced **exactly 6 single-cut clips and at least 2 multi-cut clips** (8-9 clips total).
2. **Every cut starts at a sentence boundary** — the timestamp matches the first word of a sentence (the previous word in the TSV ends with `.`, `!`, or `?`, OR the cut starts at the first word of the transcript).
3. **Every cut ends at a sentence boundary** — the timestamp is right after a word ending in `.`, `!`, or `?`.
4. **Total duration across all cuts is between 20 and 30 seconds.** Compute it: sum of (end − start) for each cut. Reject and rework any clip outside this range.
5. The exact text within each clip's chosen cuts forms a complete, logical, satisfying narrative when played back-to-back.
6. The clip contains a clear takeaway.

Use the exact timestamps from the TSV file. Do not approximate.
