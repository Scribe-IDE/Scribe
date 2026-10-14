# Example: comparing optimisers on two moons

A short machine-learning paper in which nothing is typed in by hand that the code could
produce. Open this folder in Scribe and press Cmd+Enter.

## What comes from the notebook

`notebooks/experiment.py` trains one small network three times (SGD, momentum, Adam) using
only NumPy and Matplotlib, in under a second. From it the paper gets:

- two figures: `\nbfig{fig-curves}` and `\nbfig{fig-boundary}`
- the results table: `\nbtable{results}`
- every number in the text, with its uncertainty: `\nbval{best-acc}` prints as (96.0 ± 0.3) %
- a formula: `\nbmath{n-params}`
- the reproducibility appendix: `\nbenv` (Python, packages, seeds, commit, date)

## Things to try

1. **Change the experiment.** In the notebook, set `HIDDEN = 4` or `EPOCHS = 60`, or add a seed
   to `SEEDS`, and compile.
   The figures, the table and the sentences that quote them all change together.
2. **Jump between PDF and source.** Double-click a paragraph in the PDF, or highlight some
   text there and press "Show in source".
3. **Let completion do the lookups.** Type `\ref{`, `\cite{`, `\nbfig{` or `\nbval{` in a
   `.tex` file.
4. **Open the Figures panel** in the sidebar to see each figure and value, which notebook
   makes it, and whether the paper uses it.
5. **Open the Review panel** for the `% TODO` notes left in `sections/`.
6. **Break something.** Misspell a command and compile: the problem is listed with its file
   and line, and underlined in the editor.
7. **Put the cursor in an equation** in `sections/method.tex`: the rendered formula appears
   beside it without compiling.
8. **Add a reference.** Edit ▸ Add Citation by DOI or arXiv ID…, then paste `1412.6980`.
