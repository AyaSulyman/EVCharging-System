# Document build sources

Scripts and figure sources that generate the documents in `docs/`. Kept here so the
documents can be regenerated or amended rather than rewritten by hand.

## Prerequisites

- Node with the `docx` package: `npm install` in this folder
- Python with `matplotlib` and `pillow`
- Microsoft Word (only for `pagecount.ps1`, which verifies page counts)

## Regenerating the figures

```bash
python figures.py
python figures_compact.py
cp *.png ../figures/      # publish them
```

The scripts write PNGs into this folder when run. The canonical copies live in
`docs/figures/` — copy them across after regenerating.

Figures are drawn 1:1 at their final printed size, so the point sizes in the scripts
are the point sizes that appear on the page. Changing a figure's `figsize` without
rescaling its fonts will make the text unreadable in the document.

| Figure file | Used in | Placed at |
|---|---|---|
| `fig1_architecture.png` | Full proposal, Fig. 1 | 6.2 in wide |
| `fig2_erd.png` | Full proposal, Fig. 2 (landscape page) | 8.6 in wide |
| `fig3_future.png` | Full proposal, Fig. 3 | 6.2 in wide |
| `fig4_timeline.png` | Full proposal, Fig. 4 | 6.2 in wide |
| `fig_erd_compact.png` | Condensed proposal + System Specification | 6.35–6.45 in wide |
| `fig_arch_compact.png` | Condensed proposal, Fig. 1 | 6.0 in wide |

## Regenerating the documents

```bash
node build.js        # ChargeHub_Project_Proposal.docx      (full, ~35 pages)
node build5.js       # ChargeHub_Proposal_Summary.docx      (condensed, 4 pages)
node build_spec.js   # ChargeHub_System_Specification.docx  (4 pages)
```

Each script writes directly into `docs/`.

## Verifying page count

```powershell
.\pagecount.ps1 -Docx "..\ChargeHub_Proposal_Summary.docx" -Pdf ".\preview.pdf"
```

Prints the true page and word count from Word, and optionally exports a PDF for
visual checking. Page counts in the documents were verified this way, not estimated.

## Note on the full proposal

`build.js` produces the long academic proposal with a cover page, table of contents
and list of figures/tables. Those lists are Word fields — after opening the file,
select all and press F9 to populate them.
