// How each document family looks in the viewer's chrome.
import type { DocumentFamily } from "@/lib/formats";
import type { IconName } from "@/components/ui/icon";

export function familyIcon(family: DocumentFamily | null): IconName {
  switch (family) {
    case "pdf":
      return "FilePdf";
    case "text":
      return "FileWord";
    case "presentation":
      return "FilePowerPoint";
    case "spreadsheet":
      return "FileExcel";
    default:
      return "FileText";
  }
}

/** What the viewer is doing while a file opens; conversions take seconds. */
export function openingMessage(family: DocumentFamily | null): string {
  switch (family) {
    case "text":
    case "presentation":
      return "Converting to PDF…";
    case "spreadsheet":
      return "Reading the workbook…";
    default:
      return "Opening…";
  }
}
