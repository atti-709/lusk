import Foundation

// Remove the local copy of cloud-synced files (Google Drive / iCloud File Provider) while
// keeping them in the cloud — the Finder's "Remove Download". A file that isn't uploaded
// yet can't be evicted and reports failure instead of losing data.
let paths = CommandLine.arguments.dropFirst()
var failed = false
for p in paths {
    do {
        try FileManager.default.evictUbiquitousItem(at: URL(fileURLWithPath: p))
        print("evicted\t\(p)")
    } catch {
        print("failed\t\(p)\t\(error.localizedDescription)")
        failed = true
    }
}
exit(failed ? 1 : 0)
