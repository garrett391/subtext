# Subtext

Explore books as a map. Search for a book, a writer, or a subject, and Subtext draws a network where things catalogued alike sit close together and share colours.

Book maps, author maps, subject maps, and influence maps — who read whom — plus paths that connect any two books.

## Setup

You need [Node.js](https://nodejs.org) 20 or newer. That's all: Open Library and Wikidata are both open, so there's no account to make and no API key to paste.

```bash
npm install
npm run dev
```

Open <http://127.0.0.1:5173>.

## Using it

- **Search** for a book, a writer, or a subject. Pick a subject to add it as a chip, and add up to four to combine them, like `graphic novels` + `autobiography`.
- Anything already drawn shows up under **On this map** at the top of the results, with no network call. Picking it jumps to that dot instead of starting a new map — handy once a map gets dense, or on touch where there's no hover.
- **Hover** a dot to see its neighbourhood. **Click** it for details, subjects, and a ranked list of everything else filed under the same headings.
- That list is the full ranking, not only what the map drew, so it doubles as a way to read a map on a phone where few labels fit. Rows already on the map take you to them; rows that aren't have a **+** and get added right where you are, which makes "show me more like this" one at a time instead of ten.
- **Double-click** a dot (or use "Show more like this") to grow the map outward from it.
- **Show me something different** jumps to whatever sits farthest from the dot you selected.
- Click a subject on any book or writer to map that subject. Click a book under "Best known for" to switch to a book map.
- The overview panel lists everything on the map, ranked by closeness to your starting point. Tap a row to go to that dot.
- **Copy as a reading list** puts the whole map on the clipboard as a numbered list with Open Library links — a map is already a ranked list of things to read, so it may as well be able to become a handout.
- On a phone, the details panel is a bottom sheet. Drag the grip at its top to resize it, or tap the grip to collapse it down to the grip alone and get nearly the whole screen for the map. It rests at three heights: peek, half, and full.
- Press `/` to jump to search and `Esc` to clear a selection. The browser's back button works, and every map has its own URL you can bookmark.

### Influence

**Trace their influence** builds a different kind of map. Every other line in Subtext is symmetric — two books resemble each other — but influence points one way, so those maps are drawn with arrows, and the layout reads left to right: writers who came before sit to the left of your writer, writers who came after sit to the right. A second hop reaches back another generation, which is where it stops being a list and starts being a line of descent.

This is the one thing here a catalogue can't give you. It comes from Wikidata's "influenced by" property, which is an editorial claim rather than a measurement: someone read the biographies and recorded that one writer shaped another. Coverage runs deep for well-documented writers and stops dead for many others. Read the arrows as arguments, which for a writing class is the interesting part.

### Paths

**Find a path from here** draws a route between two books, following the strongest connections all the way: a lineage from one book to another without an abrupt jump.

Once you've started a path, the other end can be a dot on the current map, or anything found through the search bar. Subtext routes between books, so a writer at either end becomes the book of theirs that stayed in print longest.

Paths have their own URLs, so `#path/book/OL2163089W/to/book/OL3521805W` can be bookmarked or shared. **Clear the path** puts the surrounding map back.

## How it works

**Data.** [Open Library](https://openlibrary.org) supplies titles, writers, covers, and the subject headings every map is built from. [Wikidata](https://www.wikidata.org) supplies the influence arrows. Neither needs a key.

**Similarity.** Open Library has no "books like this book" endpoint, so similarity is computed rather than looked up. Every work carries a list of subjects, and three things happen to that list before it's usable:

1. *The metadata goes.* A lot of what's filed under "subjects" describes the scan rather than the book — "Accessible book", "Protected DAISY", "nyt:graphic_books=2010-04-25".
2. *Compound headings are split into facets.* Library subjects arrive as compounds: `Superheroes -- Comic books, strips, etc.`, or the publisher's `COMICS & GRAPHIC NOVELS / Superheroes`. Splitting on the separators means a book catalogued one way still matches a book catalogued the other.
3. *They're weighted by rarity.* "Fiction" says almost nothing; "Autobiographical comics" says almost everything. Every subject search reports how many books carry that heading, and that count becomes the weight. Subtext remembers what it learns, so later maps in a session are sharper than earlier ones.

Two books are then compared by cosine similarity over those weighted facets.

**Building a map.** Subtext takes the subjects that make the seed specific, reads what else is filed under each, and ranks what comes back on two things: how much of the seed's subject profile it shares, and how many of those subject lists it turned up in, and how high. Because every candidate arrives with its own subject list, the links *between* candidates cost nothing extra — a recommendation API would need one request per connection. Each dot keeps only its strongest handful of links, which is what separates a map you can read from a ball of yarn.

**Colour.** Colours come from the layout itself. The seed sits near-white at the centre, and colour gets more vivid with distance, with the direction setting the hue. Since the force layout pulls similar books together, neighbours share hues and distant corners of the map land on opposite sides of the colour wheel. Colours use OKLCH so every hue has the same perceived brightness. On an influence map this has a useful side effect: because generations are laid out left to right, ancestors and descendants land in opposite hue families.

**Paths between two books.** Subtext reads outward from both ends at once, strongest links first, checking after each round whether the two sides have met. Every step also links back to what's already been found, so by the time they touch there's a real weighted graph to search, and the route returned is the smoothest one through it rather than the first one that closed the gap. The map then shows the route plus the closest books around each step.

The budget counts books opened, not requests: 12 by default, up to 30. Opening a book means reading the two subjects that lead out of it, and since neighbouring books share subjects heavily, most of those reads come back from the cache.

**Graph algorithms** (in `src/graph/analysis.js`):

- *Clusters* come from Louvain community detection.
- *Bridges* are dots with high betweenness centrality whose neighbours span more than one cluster — usually the most interesting thing on a map.
- *Paths* use Dijkstra's algorithm, where a strong resemblance counts as a short distance.

**Caching.** Results are saved in your browser (IndexedDB) for a week, so maps you've seen load instantly and two free services aren't asked the same question twice. Requests are paced at about four a second. You can clear saved results from the info button in the top bar.

**Addresses.** Books and writers live in the URL by their Open Library ID rather than their name, because titles collide constantly. A URL can also name something instead — `#book/q/Watchmen` or `#author/q/Ursula K. Le Guin` — which gets resolved once and rewritten to the stable form.

## Project structure

```
src/
  api/
    openlibrary.js  Open Library client: pacing, caching, error messages, clean data shapes
    wikidata.js     Influence claims over SPARQL, with graceful failure
    cache.js        Memory and IndexedDB cache
  graph/
    subjects.js     Subject cleaning, faceting and weighting — the similarity model
    build.js        Builds book, author, subject, influence and path maps; grows maps from a dot
    analysis.js     Clusters, bridges, paths, farthest dot
    color.js        Spectral colouring
  ui/
    graphView.js    D3 rendering, force layout, directed influence arrows, zoom, hover, labels
    search.js       Search box with book, author and subject results
    panel.js        Details panel
    sheet.js        Bottom-sheet behaviour for the panel on small screens
    about.js        Where the data comes from, and clearing the cache
    status.js       Status line
    dom.js          Small DOM helper and icons
  main.js           Routing and app state
  style.css         All styles
test/
  run.mjs           The subject model and every map builder, against a fake catalogue
  ui.mjs            The interface booted in jsdom and driven through real flows
  harness.mjs       Stand-in Open Library and Wikidata
```

## Tests

```bash
npm test
```

Neither service is contacted. `test/harness.mjs` answers in the same shapes the real ones do, which means the scoring, the weaving, the direction of every influence arrow, and the whole routing-to-panel path are all exercised offline. There's also `npm run render`, which dumps the empty-state sketch and a live map to SVG so the drawing code can be looked at rather than only asserted about.

## Known limits

- Open Library's cataloguing is uneven. A well-known book has dozens of useful subjects; an obscure one may have three, and a recent one may have none, in which case Subtext says so and suggests mapping the writer instead.
- Subject headings are phrased in ways nobody guesses — half of comics history sits under `Comic books, strips, etc`. The search box carries a starting vocabulary of headings that do return books, and shows how many books are behind each suggestion.
- Shared subjects are a real signal but a different one from what readers think goes together. Two books can be catalogued identically and read nothing alike.
- Wikidata's influence coverage is thin outside well-documented writers, and absent for most living ones.
- Open Library's search can be slow under load. Requests time out after twenty seconds with a message saying so.

## Next steps
- **Bugs:** 
    * When selecting an author, under influnce, there is often nullnull written.
- **Very next:** When clicking on a book, have the description much higher up. Right now its all the way down. Either below the 
- **Next:** Subject maps that show writers as well as books, so a territory can be read either way without switching maps.
- **Then:** Use Open Library's subject facets to suggest where to go next from a subject map — the headings that keep company with the one you're on.
- **Then:** Influence maps seeded from a book rather than a writer, following the book's author but weighting toward writers working in the same form.
- **Stretch:** Let a map hold both books and writers at once, with the links between them drawn differently from the links among them. Bigger lift: today's colouring assumes one kind of thing per map.
- **Later:** Editions and translations as a dimension of their own, so a map can show how a book travelled rather than only what it sits beside.
