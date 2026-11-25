// Loaded only when a markdown cell contains math: KaTeX and its stylesheet
// (fonts included) stay out of every other chunk.
import "katex/dist/katex.min.css";
import { createMathPlugin } from "@streamdown/math";

// Jupyter renders `$x$` as inline math (MathJax's convention), so notebooks
// rely on it.
export const notebookMath = createMathPlugin({ singleDollarTextMath: true });
