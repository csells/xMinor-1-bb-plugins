// bb-plugin-doc-review — frontend entry.
//
// One file opener for Markdown, PDF, Word, PowerPoint, and Excel: files open
// in a panel tab beside the chat, where they can be read and commented on
// (see ui/review-opener.tsx). The sidebar page lists files with comments,
// recent files, and a folder browser.
import { definePluginApp } from "@get-bb/plugin-sdk/app";
import "./app.css";
import {
  PDF_EXTENSIONS,
  PRESENTATION_EXTENSIONS,
  SPREADSHEET_EXTENSIONS,
  TEXT_EXTENSIONS,
} from "./lib/formats";
import { MARKDOWN_EXTENSIONS } from "./src/types";
import { ReviewOpener } from "./ui/review-opener";
import { PANEL_PATH, ReviewsPage } from "./ui/reviews-page";

export default definePluginApp((app) => {
  app.slots.fileOpener({
    id: "review",
    title: "Doc Review (view and comment)",
    extensions: [
      ...MARKDOWN_EXTENSIONS,
      ...PDF_EXTENSIONS,
      ...TEXT_EXTENSIONS,
      ...PRESENTATION_EXTENSIONS,
      ...SPREADSHEET_EXTENSIONS,
    ],
    component: ReviewOpener,
  });

  app.slots.navPanel({
    id: "doc-review",
    title: "Doc Review",
    icon: "FileText",
    path: PANEL_PATH,
    component: ReviewsPage,
  });
});
