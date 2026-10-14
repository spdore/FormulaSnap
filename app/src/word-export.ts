import JSZip from "jszip";
import { renderFormulaOmml } from "./formats";

export async function createEditableWordDocument(source: string): Promise<Blob> {
  const formula = renderFormulaOmml(source);
  const zip = new JSZip();
  zip.file("[Content_Types].xml",
    "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>" +
    "<Types xmlns=\"http://schemas.openxmlformats.org/package/2006/content-types\">" +
    "<Default Extension=\"rels\" ContentType=\"application/vnd.openxmlformats-package.relationships+xml\"/>" +
    "<Default Extension=\"xml\" ContentType=\"application/xml\"/>" +
    "<Override PartName=\"/word/document.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml\"/>" +
    "</Types>");
  zip.file("_rels/.rels",
    "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>" +
    "<Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\">" +
    "<Relationship Id=\"rId1\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument\" Target=\"word/document.xml\"/>" +
    "</Relationships>");
  zip.file("word/document.xml",
    "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>" +
    "<w:document xmlns:w=\"http://schemas.openxmlformats.org/wordprocessingml/2006/main\" " +
    "xmlns:m=\"http://schemas.openxmlformats.org/officeDocument/2006/math\">" +
    "<w:body><w:p><m:oMathPara><m:oMath>" + formula + "</m:oMath></m:oMathPara></w:p>" +
    "<w:sectPr/></w:body></w:document>");
  return zip.generateAsync({
    type: "blob",
    mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
  });
}