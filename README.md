# Iced Letters

**Try it: <https://taliaren.github.io/name-iced/>**

A frosted window on a winter night. Whatever you type freezes into carved letters of clear ice, with ice flowers, leaves and icicles growing on their strokes. Everything is drawn and voiced in the browser: the ice, the frost on the glass, the warm light of a house across the street and every sound.

Works with Latin letters and Chinese characters, on desktop and on phones.

## How to play

| Gesture | What happens |
| --- | --- |
| Type | Frost mist outlines the letter, then contracts into clear ice |
| Delete (Backspace) | The last letter melts away from the top down |
| Tap a letter | It shatters |
| Double-tap | Everything shatters |
| Hold a letter | It melts, leaving a faint afterimage on the glass |
| Drag | Wipes the frost off the window |
| Space | Keeps a space, and a small snowflake drifts down through the gap |
| Enter | Starts a new line |

The buttons at the bottom show the tips again, bring up the keyboard (on phones) and save the scene as a PNG.

## Play online

Open <https://taliaren.github.io/name-iced/> in a desktop or mobile browser - nothing to install. three.js, opentype.js and the fonts load from the jsDelivr CDN, and only the glyphs you actually type are downloaded. Sound starts after your first tap or key press (browsers don't allow audio before that).

## Run it locally

The page loads ES modules and fonts, so it has to be served over HTTP (opening `index.html` directly won't work):

```bash
python3 serve.py
```

Then open <http://localhost:5392>. To try it on a phone, open your computer's IP address on the same network and tap the keyboard button.

## How it works

Everything lives in `main.js`:

- Each character's outline is read with opentype.js and extruded into a block of ice (a `MeshPhysicalMaterial` with transmission), with a melt shader that eats it away from the top down.
- Ice flowers, leaves, icicles and frost patches are generated procedurally on the strokes, and melt and shatter together with their letter.
- The background is a procedural frosted window; dragging paints into a mask that clears the frost.
- Bloom runs through three.js's `EffectComposer`.
- All sound effects are synthesised with the Web Audio API (no audio files).

## Fonts

- **Gilda Display** (Eben Sorkin) — Latin letters, digits and the title, via Fontsource. SIL Open Font License.
- **瑞美加张清平硬笔行书** (a pen-written running script) — Chinese characters, via the Chinese Webfont Project (`@chinese-fonts`). Please check its terms before reusing it elsewhere.

Fonts load per unicode-range slice, so only the characters you type are fetched.
