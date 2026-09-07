<!-- Padded deliberately (task 243, lead review round 5): the cross-doc legs in
     anchor-links.spec.ts assert SCROLL POSITION, not the transient flash class — a heading that
     fits in the initial viewport would make "scrolled to it" indistinguishable from "was already
     there". Every filler paragraph below is real vertical height, pushing "Shared Name" and
     "Sibling Target" well below any plausible single-viewport fold from a fresh scrollTop-0
     open, so a poll finding either heading in view is genuine proof `scrollIntoView` ran. -->

# Sibling Doc

Filler paragraph 1 of 30, pushing "Shared Name" below the initial viewport fold.

Filler paragraph 2 of 30, pushing "Shared Name" below the initial viewport fold.

Filler paragraph 3 of 30, pushing "Shared Name" below the initial viewport fold.

Filler paragraph 4 of 30, pushing "Shared Name" below the initial viewport fold.

Filler paragraph 5 of 30, pushing "Shared Name" below the initial viewport fold.

Filler paragraph 6 of 30, pushing "Shared Name" below the initial viewport fold.

Filler paragraph 7 of 30, pushing "Shared Name" below the initial viewport fold.

Filler paragraph 8 of 30, pushing "Shared Name" below the initial viewport fold.

Filler paragraph 9 of 30, pushing "Shared Name" below the initial viewport fold.

Filler paragraph 10 of 30, pushing "Shared Name" below the initial viewport fold.

Filler paragraph 11 of 30, pushing "Shared Name" below the initial viewport fold.

Filler paragraph 12 of 30, pushing "Shared Name" below the initial viewport fold.

Filler paragraph 13 of 30, pushing "Shared Name" below the initial viewport fold.

Filler paragraph 14 of 30, pushing "Shared Name" below the initial viewport fold.

Filler paragraph 15 of 30, pushing "Shared Name" below the initial viewport fold.

Filler paragraph 16 of 30, pushing "Shared Name" below the initial viewport fold.

Filler paragraph 17 of 30, pushing "Shared Name" below the initial viewport fold.

Filler paragraph 18 of 30, pushing "Shared Name" below the initial viewport fold.

Filler paragraph 19 of 30, pushing "Shared Name" below the initial viewport fold.

Filler paragraph 20 of 30, pushing "Shared Name" below the initial viewport fold.

Filler paragraph 21 of 30, pushing "Shared Name" below the initial viewport fold.

Filler paragraph 22 of 30, pushing "Shared Name" below the initial viewport fold.

Filler paragraph 23 of 30, pushing "Shared Name" below the initial viewport fold.

Filler paragraph 24 of 30, pushing "Shared Name" below the initial viewport fold.

Filler paragraph 25 of 30, pushing "Shared Name" below the initial viewport fold.

Filler paragraph 26 of 30, pushing "Shared Name" below the initial viewport fold.

Filler paragraph 27 of 30, pushing "Shared Name" below the initial viewport fold.

Filler paragraph 28 of 30, pushing "Shared Name" below the initial viewport fold.

Filler paragraph 29 of 30, pushing "Shared Name" below the initial viewport fold.

Filler paragraph 30 of 30, pushing "Shared Name" below the initial viewport fold.

## Shared Name

"Shared Name" above is deliberately at a DIFFERENT ordinal index than main.md's own "Shared
Name" heading (main: index 2, sibling: index 1) — task 243's cross-doc resolution must resolve
`#shared-name` against THIS file's headings, not the document that contained the link; if it
ever resolved against the wrong document, this index mismatch is what would make the bug
observable (see test/vscode-e2e/anchor-links.spec.ts).

Filler paragraph 1 of 30, pushing "Sibling Target" well below "Shared Name" too — the two
headings need to be far enough apart that scrolling to one puts the other out of view, so the
shared-name-trap leg's negative check (was "Sibling Target" NOT flashed/scrolled-to) is
meaningful rather than a coincidence of both fitting in one tall viewport.

Filler paragraph 2 of 30, pushing "Sibling Target" well below "Shared Name".

Filler paragraph 3 of 30, pushing "Sibling Target" well below "Shared Name".

Filler paragraph 4 of 30, pushing "Sibling Target" well below "Shared Name".

Filler paragraph 5 of 30, pushing "Sibling Target" well below "Shared Name".

Filler paragraph 6 of 30, pushing "Sibling Target" well below "Shared Name".

Filler paragraph 7 of 30, pushing "Sibling Target" well below "Shared Name".

Filler paragraph 8 of 30, pushing "Sibling Target" well below "Shared Name".

Filler paragraph 9 of 30, pushing "Sibling Target" well below "Shared Name".

Filler paragraph 10 of 30, pushing "Sibling Target" well below "Shared Name".

Filler paragraph 11 of 30, pushing "Sibling Target" well below "Shared Name".

Filler paragraph 12 of 30, pushing "Sibling Target" well below "Shared Name".

Filler paragraph 13 of 30, pushing "Sibling Target" well below "Shared Name".

Filler paragraph 14 of 30, pushing "Sibling Target" well below "Shared Name".

Filler paragraph 15 of 30, pushing "Sibling Target" well below "Shared Name".

Filler paragraph 16 of 30, pushing "Sibling Target" well below "Shared Name".

Filler paragraph 17 of 30, pushing "Sibling Target" well below "Shared Name".

Filler paragraph 18 of 30, pushing "Sibling Target" well below "Shared Name".

Filler paragraph 19 of 30, pushing "Sibling Target" well below "Shared Name".

Filler paragraph 20 of 30, pushing "Sibling Target" well below "Shared Name".

Filler paragraph 21 of 30, pushing "Sibling Target" well below "Shared Name".

Filler paragraph 22 of 30, pushing "Sibling Target" well below "Shared Name".

Filler paragraph 23 of 30, pushing "Sibling Target" well below "Shared Name".

Filler paragraph 24 of 30, pushing "Sibling Target" well below "Shared Name".

Filler paragraph 25 of 30, pushing "Sibling Target" well below "Shared Name".

Filler paragraph 26 of 30, pushing "Sibling Target" well below "Shared Name".

Filler paragraph 27 of 30, pushing "Sibling Target" well below "Shared Name".

Filler paragraph 28 of 30, pushing "Sibling Target" well below "Shared Name".

Filler paragraph 29 of 30, pushing "Sibling Target" well below "Shared Name".

Filler paragraph 30 of 30, pushing "Sibling Target" well below "Shared Name".

## Sibling Target

Some text under the sibling target heading.

<a name="named-target"></a>

Named anchor target body.
