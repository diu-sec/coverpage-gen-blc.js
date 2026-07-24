import initZipReportGen, { zip_to_text } from "../lib/zip_report_wasm.js";
import initZipBundle, { bundle } from "../lib/zip_bundle_wasm.js";
import { pdfAddCoverFields } from "../lib/v2-pdf.js";

let initialized = false;

async function ensureInitialized() {
    if (initialized)
        return;

    await initZipBundle();
    await initZipReportGen();

    initialized = true;
}

function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);

    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();

    URL.revokeObjectURL(url);
}


export async function patchZipInput(coverpage_preset, data, shouldDownload = false) {
    await ensureInitialized()

    var timer = setInterval(async function () {

        var input = document.querySelector('input[type=file]');

        if (!input || input.files.length === 0)
            return;

        let filename = [
            data["Student ID"],
            data["Student Name"],
            data.Section,
            data["Course Code"],
            data.Semester,
        ]
        .map(x => String(x).trim().replace(/\s+/g, "_"))
        .join("-") + "_bundle.zip";

        console.log(filename);

        clearInterval(timer);

        const originalFile = input.files[0];

        const zipBytes = new Uint8Array(await originalFile.arrayBuffer());

        const reportText = zip_to_text(zipBytes);

        const { blob: pdfBlob } = await pdfAddCoverFields(
            coverpage_preset,data,
           
            {
                appendText: reportText
            }
        );

        const pdfBytes = new Uint8Array(await pdfBlob.arrayBuffer());

        const bundledZip = bundle([
            {
                path: "report.txt",
                contents: new TextEncoder().encode(reportText)
            },
            {
                path: "report.pdf",
                contents: pdfBytes
            },
            {
                path: originalFile.name,
                contents: zipBytes
            }
        ]);

        const blob = new Blob([bundledZip], {
            type: "application/zip"
        });

        const newFile = new File(
            [blob],
            filename,
            {
                type: "application/zip"
            }
        );

        var dt = new DataTransfer();
        dt.items.add(newFile);

        input.files = dt.files;

        if (shouldDownload)
            downloadBlob(blob, filename);

        console.log("Replaced:", input.files[0].name);

    }, 1000);
}
