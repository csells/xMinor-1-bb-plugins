// Open Packaging Conventions: how the parts of an OOXML zip find each other.
//
// Part names are never guessed from file names — `xl/worksheets/sheet3.xml`
// may well hold the first tab. Every lookup goes through relationships, which
// is also what makes Strict OOXML and odd writers work.
import type { Pacer } from "./pacer.js";
import { parseXmlPart, type XmlAttributes } from "./xml.js";
import type { ZipArchive, ZipEntry } from "./zip.js";

export interface Relationship {
  id: string;
  /** Last segment of the type URI: "worksheet", "styles", "hyperlink"… */
  kind: string;
  /** Resolved part name for internal targets; the raw URI for external ones. */
  target: string;
  external: boolean;
}

/**
 * The relationship type's last path segment. Transitional
 * (`schemas.openxmlformats.org/…/relationships/worksheet`), Strict
 * (`purl.oclc.org/ooxml/…/relationships/worksheet`) and Microsoft extension
 * URIs all end in the same word.
 */
export function relationshipKind(type: string): string {
  return type.slice(type.lastIndexOf("/") + 1);
}

/** `xl/workbook.xml` → `xl/_rels/workbook.xml.rels`; the package itself is "". */
export function relationshipsPartName(partName: string): string {
  const slash = partName.lastIndexOf("/");
  return `${partName.slice(0, slash + 1)}_rels/${partName.slice(slash + 1)}.rels`;
}

/** Resolves a relationship target against the directory of its source part. */
export function resolvePartName(sourcePart: string, target: string): string {
  const normalized = target.replace(/\\/g, "/");
  const path = normalized.startsWith("/")
    ? normalized
    : `${sourcePart.slice(0, sourcePart.lastIndexOf("/") + 1)}${normalized}`;
  const segments: string[] = [];
  for (const segment of path.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") segments.pop();
    else segments.push(segment);
  }
  return segments.join("/");
}

/**
 * Finds a part in the zip. Part names are URIs, so a percent-encoded target
 * may name a zip entry stored decoded (or the other way around).
 */
export function findPart(zip: ZipArchive, partName: string): ZipEntry | undefined {
  const direct = zip.get(partName);
  if (direct) return direct;
  try {
    return zip.get(decodeURIComponent(partName));
  } catch {
    return undefined;
  }
}

/** Relationships of a part (or of the package for ""); none when the rels part is absent. */
export async function readRelationships(
  zip: ZipArchive,
  sourcePart: string,
  pacer: Pacer,
): Promise<Relationship[]> {
  const entry = findPart(zip, relationshipsPartName(sourcePart));
  if (!entry) return [];
  const relationships: Relationship[] = [];
  await parseXmlPart(
    zip,
    entry,
    {
      open(name: string, attributes: XmlAttributes) {
        if (name !== "Relationship") return;
        const { Id: id, Type: type, Target: target } = attributes;
        if (!id || !type || target === undefined) return;
        const external = attributes.TargetMode === "External";
        relationships.push({
          id,
          kind: relationshipKind(type),
          target: external ? target : resolvePartName(sourcePart, target),
          external,
        });
      },
      close() {},
    },
    pacer,
  );
  return relationships;
}

export interface ContentTypes {
  /** Content type of a part name, from an override or its extension's default. */
  of(partName: string): string | undefined;
}

export async function readContentTypes(zip: ZipArchive, pacer: Pacer): Promise<ContentTypes> {
  const overrides = new Map<string, string>();
  const defaults = new Map<string, string>();
  const entry = zip.get("[Content_Types].xml");
  if (entry) {
    await parseXmlPart(
      zip,
      entry,
      {
        open(name: string, attributes: XmlAttributes) {
          const type = attributes.ContentType;
          if (!type) return;
          if (name === "Override" && attributes.PartName) {
            overrides.set(resolvePartName("", attributes.PartName).toLowerCase(), type);
          } else if (name === "Default" && attributes.Extension) {
            defaults.set(attributes.Extension.toLowerCase(), type);
          }
        },
        close() {},
      },
      pacer,
    );
  }
  return {
    of(partName: string) {
      const key = partName.toLowerCase();
      const override = overrides.get(key);
      if (override) return override;
      const dot = key.lastIndexOf(".");
      return dot === -1 ? undefined : defaults.get(key.slice(dot + 1));
    },
  };
}
