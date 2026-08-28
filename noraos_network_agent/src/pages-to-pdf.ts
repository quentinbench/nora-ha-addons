import { PDFDocument } from 'pdf-lib';

/** Assemble une liste de pages JPEG en un seul PDF (une page par image). */
export async function jpegPagesToPdf(pages: Buffer[]): Promise<Buffer> {
    const doc = await PDFDocument.create();
    for (const jpeg of pages) {
        try {
            const img = await doc.embedJpg(jpeg);
            const page = doc.addPage([img.width, img.height]);
            page.drawImage(img, { x: 0, y: 0, width: img.width, height: img.height });
        } catch {
            // Page illisible/format inattendu : ignorée plutôt que de casser tout le document.
        }
    }
    const bytes = await doc.save();
    return Buffer.from(bytes);
}
