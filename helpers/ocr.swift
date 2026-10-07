// cloudtidy-ocr: prints recognized text of an image or a scanned PDF (first 2 pages).
// Built by `cloudtidy install` with: swiftc -O -o <helper> ocr.swift
import AppKit
import Foundation
import ImageIO
import PDFKit
import Vision

let maxPages = 2

func recognize(_ image: CGImage) -> String {
    let request = VNRecognizeTextRequest()
    request.recognitionLevel = .accurate
    request.recognitionLanguages = ["de-DE", "en-US"]
    request.usesLanguageCorrection = true
    let handler = VNImageRequestHandler(cgImage: image, options: [:])
    do {
        try handler.perform([request])
    } catch {
        return ""
    }
    let observations = request.results ?? []
    return observations.compactMap { $0.topCandidates(1).first?.string }.joined(separator: "\n")
}

func renderPdfPages(_ url: URL) -> [CGImage] {
    guard let document = PDFDocument(url: url) else { return [] }
    var images: [CGImage] = []
    for index in 0..<min(document.pageCount, maxPages) {
        guard let page = document.page(at: index) else { continue }
        let bounds = page.bounds(for: .mediaBox)
        // 2x scale keeps small print legible for Vision.
        let size = NSSize(width: bounds.width * 2, height: bounds.height * 2)
        let thumbnail = page.thumbnail(of: size, for: .mediaBox)
        if let image = thumbnail.cgImage(forProposedRect: nil, context: nil, hints: nil) {
            images.append(image)
        }
    }
    return images
}

func loadImage(_ url: URL) -> [CGImage] {
    guard let source = CGImageSourceCreateWithURL(url as CFURL, nil),
          let image = CGImageSourceCreateImageAtIndex(source, 0, nil)
    else { return [] }
    return [image]
}

let arguments = CommandLine.arguments
guard arguments.count == 2 else {
    FileHandle.standardError.write(Data("usage: cloudtidy-ocr <file>\n".utf8))
    exit(2)
}

let url = URL(fileURLWithPath: arguments[1])
let images = url.pathExtension.lowercased() == "pdf" ? renderPdfPages(url) : loadImage(url)
guard !images.isEmpty else {
    FileHandle.standardError.write(Data("cloudtidy-ocr: could not read \(url.path)\n".utf8))
    exit(1)
}
print(images.map(recognize).joined(separator: "\n\n"))
