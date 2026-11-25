#!/usr/bin/env -S swift -suppress-warnings
// mGit 전용 코드 서명 identity를 생성·검사·백업·복원한다. 암호와 개인 키는 출력하지 않는다.
import CryptoKit
import Darwin
import Foundation
import Security

let commonName = "mGit"
let schemaVersion = 1
let fm = FileManager.default
let root = URL(fileURLWithPath: #filePath).standardizedFileURL.deletingLastPathComponent().deletingLastPathComponent()
let pinURL = root.appendingPathComponent("packaging/signing-identity.json")
let privateRoot = root.appendingPathComponent("signing", isDirectory: true)

struct SigningFailure: Error { let message: String }
struct IdentityMetadata: Codable, Equatable {
    let schemaVersion: Int
    let commonName: String
    let sha1: String
    let sha256: String
    let notAfter: String
}
struct PublicStatus: Encodable {
    let status: String
    let schemaVersion: Int
    let commonName: String
    let sha1: String?
    let sha256: String?
    let notAfter: String?
    let keychain: String
}
struct IdentityEntry { let identity: SecIdentity; let certificate: SecCertificate; let metadata: IdentityMetadata }
struct Arguments { let command: String; let keychain: String; let bundle: URL?; let json: Bool }

/// 보안 자료의 내용을 오류 메시지에 섞지 않고 알려진 설명만 반환한다.
func require(_ condition: @autoclosure () throws -> Bool, _ message: String) throws {
    if try !condition() { throw SigningFailure(message: message) }
}
/// Security 오류는 공개 상태 코드와 작업 이름만 표시한다.
func check(_ code: OSStatus, _ operation: String) throws {
    try require(code == errSecSuccess, "\(operation) 실패 (Security 상태 \(code))")
}
/// 명시된 명령과 공개 경로 옵션만 받으며 암호 인자는 받지 않는다.
func parseArguments(_ values: [String]) throws -> Arguments {
    guard let command = values.first, ["create", "status", "export", "import", "verify-backup", "self-test", "help"].contains(command) else {
        throw SigningFailure(message: "사용법: signing-identity.swift create|status|export|import|verify-backup [--json] [--keychain 경로] [--bundle 백업폴더]")
    }
    var keychain = fm.homeDirectoryForCurrentUser.appendingPathComponent("Library/Keychains/login.keychain-db").path
    var bundle: URL?
    var json = false
    var index = 1
    while index < values.count {
        switch values[index] {
        case "--json": json = true
        case "--keychain", "--bundle":
            let option = values[index]
            index += 1
            try require(index < values.count, "\(option)에 경로가 필요합니다")
            if option == "--keychain" { keychain = URL(fileURLWithPath: values[index]).standardizedFileURL.path }
            else { bundle = URL(fileURLWithPath: values[index]).standardizedFileURL }
        default: throw SigningFailure(message: "지원하지 않는 옵션입니다. 암호는 인자나 환경변수로 받지 않습니다")
        }
        index += 1
    }
    try require(!["import", "verify-backup"].contains(command) || bundle != nil, "import·verify-backup에는 --bundle 백업폴더가 필요합니다")
    try require(!["status", "self-test", "help"].contains(command) || bundle == nil, "이 명령에는 --bundle을 사용할 수 없습니다")
    return Arguments(command: command, keychain: keychain, bundle: bundle, json: json)
}
/// 공개 JSON은 키 순서를 고정하고 비밀 필드가 없는 타입만 직렬화한다.
func publicJSON<T: Encodable>(_ value: T) throws -> Data {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
    var data = try encoder.encode(value)
    data.append(10)
    return data
}
/// 고정된 이름과 지문 형식을 검사한다. 이름에 포함되는 다른 인증서는 허용하지 않는다.
func validateMetadata(_ metadata: IdentityMetadata) throws {
    try require(metadata.schemaVersion == schemaVersion && metadata.commonName == commonName, "mGit 서명 메타데이터가 아닙니다")
    let hex = CharacterSet(charactersIn: "0123456789ABCDEF")
    try require(metadata.sha1.count == 40 && metadata.sha1.unicodeScalars.allSatisfy(hex.contains), "SHA-1 지문 형식이 올바르지 않습니다")
    try require(metadata.sha256.count == 64 && metadata.sha256.unicodeScalars.allSatisfy(hex.contains), "SHA-256 지문 형식이 올바르지 않습니다")
    try require(ISO8601DateFormatter().date(from: metadata.notAfter) != nil, "인증서 만료일 형식이 올바르지 않습니다")
}
/// 공개 pin 파일은 선택한 인증서를 교체하는 수단으로 사용하지 않는다.
func readPin() throws -> IdentityMetadata? {
    guard fm.fileExists(atPath: pinURL.path) else { return nil }
    let metadata = try JSONDecoder().decode(IdentityMetadata.self, from: Data(contentsOf: pinURL))
    try validateMetadata(metadata)
    return metadata
}
/// 공개 pin과 실제 인증서가 모두 일치해야 동일 identity로 취급한다.
func matches(_ left: IdentityMetadata, _ right: IdentityMetadata) -> Bool {
    left.commonName == right.commonName && left.sha1 == right.sha1 && left.sha256 == right.sha256 && left.notAfter == right.notAfter
}
/// 인증서 DER에서 두 지문과 만료일을 얻는다. 개인 키를 읽거나 내보내지 않는다.
func metadataOf(_ certificate: SecCertificate) throws -> IdentityMetadata {
    var name: CFString?
    try check(SecCertificateCopyCommonName(certificate, &name), "인증서 이름 조회")
    try require(name as String? == commonName, "인증서 CN이 정확히 mGit이 아닙니다")
    let data = SecCertificateCopyData(certificate) as Data
    var error: Unmanaged<CFError>?
    guard let values = SecCertificateCopyValues(certificate, [kSecOIDX509V1ValidityNotAfter] as CFArray, &error) as? [String: Any],
          let property = values[kSecOIDX509V1ValidityNotAfter as String] as? [String: Any] else {
        throw SigningFailure(message: "인증서 만료일을 읽지 못했습니다")
    }
    let value = property[kSecPropertyKeyValue as String]
    let date: Date
    if let found = value as? Date { date = found }
    else if let found = value as? NSNumber { date = Date(timeIntervalSinceReferenceDate: found.doubleValue) }
    else { throw SigningFailure(message: "인증서 만료일 형식을 지원하지 않습니다") }
    return IdentityMetadata(schemaVersion: schemaVersion, commonName: commonName,
        sha1: Insecure.SHA1.hash(data: data).map { String(format: "%02X", $0) }.joined(),
        sha256: SHA256.hash(data: data).map { String(format: "%02X", $0) }.joined(),
        notAfter: ISO8601DateFormatter().string(from: date))
}
/// 지정한 키체인을 열기만 한다. 새 키체인을 만들거나 잠금 암호를 읽지 않는다.
func openKeychain(_ path: String) throws -> SecKeychain {
    var keychain: SecKeychain?
    try check(SecKeychainOpen(path, &keychain), "키체인 열기")
    guard let keychain else { throw SigningFailure(message: "키체인을 열지 못했습니다") }
    var status: SecKeychainStatus = 0
    try check(SecKeychainGetStatus(keychain, &status), "키체인 상태 조회")
    return keychain
}
/// 이름이 정확히 mGit인 identity만 조회하고 같은 인증서의 중복 결과는 합친다.
func findIdentities(_ keychain: SecKeychain) throws -> [IdentityEntry] {
    let query: [CFString: Any] = [kSecClass: kSecClassIdentity, kSecMatchLimit: kSecMatchLimitAll,
        kSecReturnRef: true, kSecMatchSearchList: [keychain]]
    var result: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &result)
    if status == errSecItemNotFound { return [] }
    try check(status, "서명 identity 조회")
    guard let identities = result as? [SecIdentity] else { throw SigningFailure(message: "identity 조회 결과를 해석하지 못했습니다") }
    var seen = Set<String>()
    var entries: [IdentityEntry] = []
    for identity in identities {
        var certificate: SecCertificate?
        try check(SecIdentityCopyCertificate(identity, &certificate), "identity 인증서 조회")
        guard let certificate else { continue }
        var name: CFString?
        guard SecCertificateCopyCommonName(certificate, &name) == errSecSuccess, name as String? == commonName else { continue }
        let metadata = try metadataOf(certificate)
        if seen.insert(metadata.sha256).inserted { entries.append(IdentityEntry(identity: identity, certificate: certificate, metadata: metadata)) }
    }
    return entries
}
/// 코드 서명 정책의 사용자 신뢰를 평가하며 네트워크 조회는 하지 않는다.
func isTrusted(_ certificate: SecCertificate) -> Bool {
    guard let policy = SecPolicyCreateWithProperties(kSecPolicyAppleCodeSigning, nil) else { return false }
    var trust: SecTrust?
    guard SecTrustCreateWithCertificates(certificate, policy, &trust) == errSecSuccess, let trust else { return false }
    SecTrustSetNetworkFetchAllowed(trust, false)
    return SecTrustEvaluateWithError(trust, nil)
}
/// pin·개인 키·유효기간·신뢰가 준비된 상태만 ready로 보고한다.
func statusOf(_ keychainPath: String) throws -> (PublicStatus, IdentityEntry?) {
    let pin = try readPin()
    let entries = try findIdentities(openKeychain(keychainPath))
    let entry = entries.count == 1 ? entries[0] : nil
    let status: String
    if entries.count > 1 { status = "ambiguous" }
    else if pin == nil || entry == nil { status = "missing" }
    else if !matches(pin!, entry!.metadata) { status = "mismatch" }
    else if ISO8601DateFormatter().date(from: entry!.metadata.notAfter)! <= Date() { status = "expired" }
    else if !isTrusted(entry!.certificate) { status = "untrusted" }
    else { status = "ready" }
    let value = entry?.metadata ?? pin
    return (PublicStatus(status: status, schemaVersion: schemaVersion, commonName: commonName,
        sha1: value?.sha1, sha256: value?.sha256, notAfter: value?.notAfter, keychain: keychainPath), entry)
}
/// 파일 경로 자체가 링크이거나 예상한 종류가 아니면 열지 않는다.
func checkFile(_ url: URL, directory: Bool) throws {
    let properties = try url.resourceValues(forKeys: [.isSymbolicLinkKey, .isRegularFileKey, .isDirectoryKey])
    try require(properties.isSymbolicLink != true && (directory ? properties.isDirectory == true : properties.isRegularFile == true), "안전한 \(directory ? "폴더" : "파일") 경로가 아닙니다")
}
/// 개인 자료 디렉터리는 저장소 안에만 만들고 다른 사용자의 접근을 차단한다.
func secureDirectory(_ url: URL) throws {
    let canonicalRoot = root.resolvingSymlinksInPath().path + "/"
    try require(url.standardizedFileURL.path.hasPrefix(root.path + "/"), "백업은 현재 저장소 내부에만 만들 수 있습니다")
    var ancestor = url
    while !fm.fileExists(atPath: ancestor.path) { ancestor.deleteLastPathComponent() }
    try require(ancestor.resolvingSymlinksInPath().path == canonicalRoot.dropLast() || ancestor.resolvingSymlinksInPath().path.hasPrefix(canonicalRoot), "백업 경로가 저장소 밖을 가리킵니다")
    try fm.createDirectory(at: url, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
    try checkFile(url, directory: true)
    try fm.setAttributes([.posixPermissions: 0o700], ofItemAtPath: url.path)
}
/// 새 파일만 O_EXCL·O_NOFOLLOW로 쓰고 디스크에 반영한다. 비밀 데이터는 호출 오류에 넣지 않는다.
func writeNew(_ data: Data, to url: URL, mode: mode_t = 0o600) throws {
    let fd = Darwin.open(url.path, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, mode)
    try require(fd >= 0, "새 파일을 만들지 못했습니다(기존 파일은 덮어쓰지 않습니다)")
    defer { Darwin.close(fd) }
    var succeeded = false
    defer { if !succeeded { try? fm.removeItem(at: url) } }
    try data.withUnsafeBytes { bytes in
        var offset = 0
        while offset < bytes.count {
            let written = Darwin.write(fd, bytes.baseAddress!.advanced(by: offset), bytes.count - offset)
            try require(written > 0, "파일 쓰기에 실패했습니다")
            offset += written
        }
    }
    try require(fsync(fd) == 0, "파일 동기화에 실패했습니다")
    succeeded = true
}
/// 충분한 엔트로피의 백업 암호를 생성하며 값은 반환한 메모리와 암호 파일에만 둔다.
func randomPassphrase() throws -> String {
    var bytes = [UInt8](repeating: 0, count: 64)
    try check(SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes), "백업 암호 생성")
    return bytes.map { String(format: "%02x", $0) }.joined()
}
/// 외부 명령에는 공개 값·파일 경로만 전달하며 출력은 내용 대신 작업 성공 여부로 처리한다.
@discardableResult
func runPublic(_ executable: String, _ arguments: [String], label: String) throws -> Data {
    let process = Process()
    process.executableURL = URL(fileURLWithPath: executable)
    process.arguments = arguments
    process.environment = ["PATH": "/usr/bin:/bin:/usr/sbin:/sbin", "HOME": fm.homeDirectoryForCurrentUser.path]
    let output = Pipe()
    process.standardOutput = output
    process.standardError = FileHandle.nullDevice
    try process.run()
    let data = output.fileHandleForReading.readDataToEndOfFile()
    process.waitUntilExit()
    try require(process.terminationReason == .exit && process.terminationStatus == 0, "\(label) 실패 (종료 코드 \(process.terminationStatus)); 비밀 값은 기록하지 않았습니다")
    return data
}
/// 새 백업 폴더는 기존 자료와 겹치지 않으며 권한을 먼저 제한한다.
func newBundle(_ proposed: URL?, suffix: String) throws -> URL {
    try secureDirectory(privateRoot)
    let formatter = DateFormatter(); formatter.dateFormat = "yyyyMMdd'T'HHmmss'Z'"; formatter.timeZone = TimeZone(secondsFromGMT: 0); formatter.locale = Locale(identifier: "en_US_POSIX")
    let output = proposed ?? privateRoot.appendingPathComponent("mGit-\(suffix)-\(formatter.string(from: Date()))-\(UUID().uuidString.prefix(6))", isDirectory: true)
    try require(output.standardizedFileURL.path.hasPrefix(privateRoot.path + "/"), "비공개 백업은 저장소의 signing/ 아래에만 만들 수 있습니다")
    try require(!fm.fileExists(atPath: output.path), "백업 폴더가 이미 있습니다. 덮어쓰지 않습니다")
    try secureDirectory(output)
    return output
}
/// 공개 인증서와 백업 메타데이터를 한 묶음으로 기록한다.
func writeCertificate(_ certificate: SecCertificate, metadata: IdentityMetadata, bundle: URL) throws {
    try writeNew(SecCertificateCopyData(certificate) as Data, to: bundle.appendingPathComponent("certificate.cer"))
    try writeNew(publicJSON(metadata), to: bundle.appendingPathComponent("identity.json"))
}
/// 최초 인증서 지문만 공개 pin으로 남긴다. 이미 있으면 같은 지문인지 확인한다.
func recordPin(_ metadata: IdentityMetadata) throws {
    if let existing = try readPin() { try require(matches(existing, metadata), "등록된 mGit 인증서와 지문이 다릅니다. 기존 인증서를 교체하지 않았습니다"); return }
    try fm.createDirectory(at: pinURL.deletingLastPathComponent(), withIntermediateDirectories: true)
    try writeNew(publicJSON(metadata), to: pinURL, mode: 0o644)
}
/// PKCS#12는 메모리에서 먼저 검사해 다른 키·인증서를 키체인에 넣지 않는다.
func inspectP12(_ data: Data, passphrase: String, expected: IdentityMetadata) throws {
    var result: CFArray?
    let options: [CFString: Any] = [kSecImportExportPassphrase: passphrase, kSecImportToMemoryOnly: true]
    try check(SecPKCS12Import(data as CFData, options as CFDictionary, &result), "암호화 백업 검사")
    guard let items = result as? [[String: Any]], items.count == 1,
          let raw = items[0][kSecImportItemIdentity as String], CFGetTypeID(raw as CFTypeRef) == SecIdentityGetTypeID() else {
        throw SigningFailure(message: "백업에는 mGit identity 하나만 있어야 합니다")
    }
    let identity = raw as! SecIdentity
    var certificate: SecCertificate?
    try check(SecIdentityCopyCertificate(identity, &certificate), "백업 인증서 조회")
    guard let certificate else { throw SigningFailure(message: "백업 인증서가 없습니다") }
    try require(matches(try metadataOf(certificate), expected), "PKCS#12와 공개 인증서의 지문이 다릅니다")
    if let chain = items[0][kSecImportItemCertChain as String] as? [SecCertificate] {
        try require(chain.count == 1, "자체 서명 mGit 인증서 하나만 복원할 수 있습니다")
    }
}
/// 인증서가 자체 서명 RSA 3072·SHA-256·codeSigning 용도인지 공개 정보만 검사한다.
func validateCertificateProfile(_ certificate: SecCertificate, url: URL, metadata: IdentityMetadata) throws {
    try require(ISO8601DateFormatter().date(from: metadata.notAfter)! > Date(), "인증서가 만료되었습니다")
    try require(SecCertificateCopyNormalizedIssuerSequence(certificate) == SecCertificateCopyNormalizedSubjectSequence(certificate), "자체 서명 인증서가 아닙니다")
    let text = try runPublic("/usr/bin/openssl", ["x509", "-inform", "DER", "-in", url.path, "-noout", "-text"], label: "공개 인증서 프로필 검사")
    guard let description = String(data: text, encoding: .utf8) else { throw SigningFailure(message: "인증서 프로필을 읽지 못했습니다") }
    try require(description.contains("sha256WithRSAEncryption") && description.contains("(3072 bit)") && description.contains("Code Signing") && description.contains("CA:FALSE"), "RSA 3072·SHA-256·codeSigning·CA:false 인증서가 필요합니다")
}
/// 암호·개인 키를 프로세스 인자에 싣지 않고 codesign만 신뢰하는 ACL로 하나의 키를 가져온다.
func importP12(_ p12: Data, passphrase: String, into keychain: SecKeychain) throws {
    var trustedApplication: SecTrustedApplication?
    try check(SecTrustedApplicationCreateFromPath("/usr/bin/codesign", &trustedApplication), "codesign 접근 권한 준비")
    guard let trustedApplication else { throw SigningFailure(message: "codesign 접근 권한을 만들지 못했습니다") }
    var access: SecAccess?
    try check(SecAccessCreate("mGit 코드 서명" as CFString, [trustedApplication] as CFArray, &access), "개인 키 접근 목록 준비")
    guard let access else { throw SigningFailure(message: "개인 키 접근 목록을 만들지 못했습니다") }
    let passphraseRef = passphrase as CFString
    var parameters = SecItemImportExportKeyParameters()
    parameters.version = UInt32(SEC_KEY_IMPORT_EXPORT_PARAMS_VERSION)
    parameters.flags = SecKeyImportExportFlags(rawValue: 1) // 개인 키 하나만 허용한다.
    parameters.passphrase = Unmanaged.passUnretained(passphraseRef)
    parameters.accessRef = Unmanaged.passUnretained(access)
    var format = SecExternalFormat.formatPKCS12
    var itemType = SecExternalItemType.itemTypeAggregate
    try check(SecItemImport(p12 as CFData, "p12" as CFString, &format, &itemType, [], &parameters, keychain, nil), "mGit identity 복원")
}
/// 비공개 백업의 파일 권한을 확인한다. 원본 권한은 자동으로 수정하지 않는다.
func requirePrivateFile(_ url: URL) throws {
    try checkFile(url, directory: false)
    let mode = (try fm.attributesOfItem(atPath: url.path)[.posixPermissions] as? NSNumber)?.intValue ?? 0o777
    try require(mode & 0o077 == 0, "백업의 identity.p12와 password.txt는 소유자만 읽을 수 있어야 합니다(0600)")
}
/// 공개 자료와 암호화 백업이 모두 일치할 때만 codesign 전용 접근 권한으로 import한다.
func installBundle(_ bundle: URL, keychainPath: String) throws -> IdentityMetadata {
    try checkFile(bundle, directory: true)
    let certificateURL = bundle.appendingPathComponent("certificate.cer")
    let metadataURL = bundle.appendingPathComponent("identity.json")
    let passwordURL = bundle.appendingPathComponent("password.txt")
    let p12URL = bundle.appendingPathComponent("identity.p12")
    for file in [certificateURL, metadataURL, passwordURL, p12URL] { try checkFile(file, directory: false) }
    let expected = try JSONDecoder().decode(IdentityMetadata.self, from: Data(contentsOf: metadataURL))
    try validateMetadata(expected)
    if let pin = try readPin() { try require(matches(pin, expected), "공개 pin과 다른 인증서입니다. 기존 서명 identity를 교체하지 않았습니다") }
    guard let certificate = SecCertificateCreateWithData(nil, try Data(contentsOf: certificateURL) as CFData) else { throw SigningFailure(message: "공개 인증서를 읽지 못했습니다") }
    try require(matches(try metadataOf(certificate), expected), "공개 인증서와 백업 메타데이터가 다릅니다")
    try validateCertificateProfile(certificate, url: certificateURL, metadata: expected)
    try requirePrivateFile(passwordURL)
    try requirePrivateFile(p12URL)
    let passphrase = try String(contentsOf: passwordURL, encoding: .utf8).trimmingCharacters(in: .newlines)
    try require(passphrase.utf8.count >= 64, "백업 암호 파일이 너무 짧습니다")
    let p12 = try Data(contentsOf: p12URL)
    try inspectP12(p12, passphrase: passphrase, expected: expected)
    let keychain = try openKeychain(keychainPath)
    let existing = try findIdentities(keychain)
    try require(existing.count <= 1 && existing.allSatisfy { matches($0.metadata, expected) }, "동일한 이름의 다른 mGit 인증서가 있습니다. 삭제하거나 교체하지 않았습니다")
    if existing.isEmpty { try importP12(p12, passphrase: passphrase, into: keychain) }
    // 신뢰 변경은 공개 인증서만 넘기며 macOS의 권한 확인 창은 그대로 따른다.
    try runPublic("/usr/bin/security", ["add-trusted-cert", "-r", "trustRoot", "-p", "codeSign", "-k", keychainPath, certificateURL.path], label: "코드 서명 신뢰 설정")
    try recordPin(expected)
    let (status, _) = try statusOf(keychainPath)
    try require(status.status == "ready", "identity가 준비되지 않았습니다 (\(status.status)); 백업 파일은 보존했습니다")
    return expected
}
/// 별도 RSA 3072·SHA-256·100년 코드 서명 인증서를 만들고 즉시 암호화 백업을 남긴다.
func createIdentity(_ arguments: Arguments) throws -> URL? {
    let keychain = try openKeychain(arguments.keychain)
    let existing = try findIdentities(keychain)
    if let pin = try readPin() {
        try require(existing.count == 1 && matches(existing[0].metadata, pin), "등록된 인증서를 먼저 import로 복원해 주세요. 새 인증서를 만들지 않았습니다")
        let (status, _) = try statusOf(arguments.keychain)
        try require(status.status == "ready", "기존 인증서 상태가 \(status.status)입니다. 백업으로 import해 복구해 주세요")
        return nil
    }
    try require(existing.isEmpty, "pin이 없는 기존 mGit identity가 있습니다. 새 키를 만들거나 기존 키를 삭제하지 않았습니다")
    var bundle = try newBundle(arguments.bundle, suffix: "new")
    let work = bundle.appendingPathComponent(".creation", isDirectory: true)
    try secureDirectory(work)
    defer { try? fm.removeItem(at: bundle.appendingPathComponent(".creation", isDirectory: true)) }
    let config = work.appendingPathComponent("certificate.cnf")
    let key = work.appendingPathComponent("private-key.pem")
    let pem = work.appendingPathComponent("certificate.pem")
    let passwordURL = bundle.appendingPathComponent("password.txt")
    try writeNew(Data("""
    [req]
    distinguished_name=dn
    prompt=no
    x509_extensions=ext
    [dn]
    CN=mGit
    [ext]
    basicConstraints=critical,CA:false
    keyUsage=critical,digitalSignature
    extendedKeyUsage=critical,codeSigning
    """.utf8), to: config)
    try writeNew(Data((try randomPassphrase() + "\n").utf8), to: passwordURL)
    try runPublic("/usr/bin/openssl", ["req", "-x509", "-newkey", "rsa:3072", "-sha256", "-nodes", "-days", "36500", "-config", config.path, "-keyout", key.path, "-out", pem.path], label: "mGit 인증서 생성")
    try fm.setAttributes([.posixPermissions: 0o600], ofItemAtPath: key.path)
    let der = try runPublic("/usr/bin/openssl", ["x509", "-in", pem.path, "-outform", "DER"], label: "공개 인증서 변환")
    guard let certificate = SecCertificateCreateWithData(nil, der as CFData) else { throw SigningFailure(message: "생성한 인증서를 읽지 못했습니다") }
    let metadata = try metadataOf(certificate)
    try writeCertificate(certificate, metadata: metadata, bundle: bundle)
    let p12URL = bundle.appendingPathComponent("identity.p12")
    try runPublic("/usr/bin/openssl", ["pkcs12", "-export", "-inkey", key.path, "-in", pem.path, "-name", commonName, "-out", p12URL.path, "-passout", "file:\(passwordURL.path)"], label: "암호화 백업 생성")
    try fm.setAttributes([.posixPermissions: 0o600], ofItemAtPath: p12URL.path)
    if arguments.bundle == nil {
        let final = bundle.deletingLastPathComponent().appendingPathComponent(bundle.lastPathComponent.replacingOccurrences(of: "mGit-new-", with: "mGit-\(metadata.sha1.prefix(12))-"), isDirectory: true)
        try fm.moveItem(at: bundle, to: final)
        bundle = final
    }
    // 키체인 작업이 중단돼도 같은 백업을 import하여 계속할 수 있도록 최초 지문을 고정한다.
    try recordPin(metadata)
    _ = try installBundle(bundle, keychainPath: arguments.keychain)
    return bundle
}
/// pin과 일치하는 identity 하나만 새 암호의 PKCS#12로 백업한다.
func exportIdentity(_ arguments: Arguments) throws -> URL {
    let (status, entry) = try statusOf(arguments.keychain)
    guard status.status == "ready", let entry else { throw SigningFailure(message: "준비된 mGit identity만 내보낼 수 있습니다 (\(status.status))") }
    let bundle = try newBundle(arguments.bundle, suffix: String(entry.metadata.sha1.prefix(12)))
    let passphrase = try randomPassphrase()
    try writeNew(Data((passphrase + "\n").utf8), to: bundle.appendingPathComponent("password.txt"))
    let passphraseRef = passphrase as CFString
    var parameters = SecItemImportExportKeyParameters()
    parameters.version = UInt32(SEC_KEY_IMPORT_EXPORT_PARAMS_VERSION)
    parameters.passphrase = Unmanaged.passUnretained(passphraseRef)
    var exported: CFData?
    try check(SecItemExport(entry.identity, .formatPKCS12, [], &parameters, &exported), "mGit identity 백업")
    guard let exported else { throw SigningFailure(message: "암호화 백업 결과가 없습니다") }
    try writeNew(exported as Data, to: bundle.appendingPathComponent("identity.p12"))
    try writeCertificate(entry.certificate, metadata: entry.metadata, bundle: bundle)
    return bundle
}
/// 임시 키체인만 검색 목록에서 제거하고 기본 키체인이 바뀐 경우에만 원래 값을 복원한다.
func cleanValidationKeychain(_ keychain: SecKeychain, oldDefault: SecKeychain?) throws {
    var currentDefault: SecKeychain?
    if SecKeychainCopyDefault(&currentDefault) == errSecSuccess, let currentDefault, CFEqual(currentDefault, keychain), let oldDefault {
        try check(SecKeychainSetDefault(oldDefault), "기본 키체인 복원")
    }
    var current: CFArray?
    try check(SecKeychainCopySearchList(&current), "키체인 검색 목록 조회")
    if let list = current as? [SecKeychain], list.contains(where: { CFEqual($0, keychain) }) {
        try check(SecKeychainSetSearchList(list.filter { !CFEqual($0, keychain) } as CFArray), "임시 키체인 검색 목록 정리")
    }
    try check(SecKeychainDelete(keychain), "임시 키체인 삭제")
}
/// 기존 키체인·신뢰·백업을 바꾸지 않고 별도 키체인 복원 및 실제 fixture 서명을 검증한다.
func verifyBackup(_ arguments: Arguments) throws {
    let bundle = arguments.bundle!
    try checkFile(bundle, directory: true)
    let p12URL = bundle.appendingPathComponent("identity.p12")
    let passwordURL = bundle.appendingPathComponent("password.txt")
    let certificateURL = bundle.appendingPathComponent("certificate.cer")
    let metadataURL = bundle.appendingPathComponent("identity.json")
    for file in [p12URL, passwordURL] { try requirePrivateFile(file) }
    for file in [certificateURL, metadataURL] { try checkFile(file, directory: false) }
    let metadata = try JSONDecoder().decode(IdentityMetadata.self, from: Data(contentsOf: metadataURL))
    try validateMetadata(metadata)
    guard let pin = try readPin(), matches(pin, metadata) else { throw SigningFailure(message: "등록한 mGit 인증서의 백업만 검증할 수 있습니다") }
    guard let certificate = SecCertificateCreateWithData(nil, try Data(contentsOf: certificateURL) as CFData) else { throw SigningFailure(message: "공개 인증서가 올바르지 않습니다") }
    try require(matches(try metadataOf(certificate), metadata), "백업 인증서가 일치하지 않습니다")
    try validateCertificateProfile(certificate, url: certificateURL, metadata: metadata)
    let passphrase = try String(contentsOf: passwordURL, encoding: .utf8).trimmingCharacters(in: .newlines)
    let p12 = try Data(contentsOf: p12URL)
    try inspectP12(p12, passphrase: passphrase, expected: metadata)
    let validation = privateRoot.appendingPathComponent(".validation/\(UUID().uuidString)", isDirectory: true)
    try secureDirectory(validation)
    let keychainPath = validation.appendingPathComponent("verification.keychain-db").path
    var oldDefault: SecKeychain?
    try check(SecKeychainCopyDefault(&oldDefault), "기본 키체인 조회")
    let password = Array(try randomPassphrase().utf8)
    var temporary: SecKeychain?
    try password.withUnsafeBytes { bytes in
        try check(SecKeychainCreate(keychainPath, UInt32(bytes.count), bytes.baseAddress, false, nil, &temporary), "임시 키체인 생성")
    }
    guard let temporary else { throw SigningFailure(message: "임시 키체인이 없습니다") }
    do {
        try importP12(p12, passphrase: passphrase, into: temporary)
        let imported = try findIdentities(temporary)
        try require(imported.count == 1 && matches(imported[0].metadata, metadata), "임시 키체인에 복원한 지문이 다릅니다")
        let fixture = validation.appendingPathComponent("signing-fixture")
        try fm.copyItem(at: URL(fileURLWithPath: "/usr/bin/true"), to: fixture)
        try fm.setAttributes([.posixPermissions: 0o700], ofItemAtPath: fixture.path)
        try runPublic("/usr/bin/codesign", ["--force", "--sign", metadata.sha1, "--keychain", keychainPath, "--identifier", "io.github.motolies.mgit.signing-test", "--timestamp=none", fixture.path], label: "복원 identity fixture 서명")
        try runPublic("/usr/bin/codesign", ["--verify", "--strict", fixture.path], label: "fixture 서명 검증")
        let prefix = validation.appendingPathComponent("signer-").path
        try runPublic("/usr/bin/codesign", ["--display", "--extract-certificates=\(prefix)", fixture.path], label: "fixture 공개 인증서 추출")
        let signerData = try Data(contentsOf: URL(fileURLWithPath: prefix + "0"))
        let signerHash = SHA256.hash(data: signerData).map { String(format: "%02X", $0) }.joined()
        try require(signerHash == metadata.sha256, "fixture의 실제 서명 인증서가 pin과 다릅니다")
    } catch {
        try cleanValidationKeychain(temporary, oldDefault: oldDefault)
        try? fm.removeItem(at: validation)
        throw error
    }
    try cleanValidationKeychain(temporary, oldDefault: oldDefault)
    try fm.removeItem(at: validation)
    print("PASS: 암호화 백업의 별도 키체인 복원·실제 코드 서명·pin 일치 확인, 임시 키체인 정리 완료")
}
/// 키체인과 인증서 생성을 건드리지 않는 정책·입출력 단위 검증이다.
func selfTest() throws {
    let valid = IdentityMetadata(schemaVersion: 1, commonName: "mGit", sha1: String(repeating: "A", count: 40), sha256: String(repeating: "B", count: 64), notAfter: "2126-01-01T00:00:00Z")
    try validateMetadata(valid)
    let wrongName = IdentityMetadata(schemaVersion: 1, commonName: "mGit Dev", sha1: valid.sha1, sha256: valid.sha256, notAfter: valid.notAfter)
    do { try validateMetadata(wrongName); throw SigningFailure(message: "정확한 CN 검증이 실패했습니다") } catch let error as SigningFailure { try require(error.message != "정확한 CN 검증이 실패했습니다", error.message) }
    try require(!matches(valid, wrongName), "서로 다른 CN을 같은 인증서로 보았습니다")
    let args = try parseArguments(["import", "--bundle", root.appendingPathComponent("test-backup").path, "--json"])
    try require(args.command == "import" && args.bundle != nil && args.json, "명령 인자 검증 실패")
    do { _ = try parseArguments(["import", "--password", "not-a-secret"]); throw SigningFailure(message: "암호 인자를 허용했습니다") } catch let error as SigningFailure { try require(error.message != "암호 인자를 허용했습니다", error.message) }
    let random = try randomPassphrase()
    try require(random.utf8.count == 128 && random.allSatisfy(\.isHexDigit), "백업 암호 생성 정책 실패")
    let scratch = root.appendingPathComponent("target/signing-self-test-\(UUID().uuidString)", isDirectory: true)
    try secureDirectory(scratch)
    defer { try? fm.removeItem(at: scratch) }
    let file = scratch.appendingPathComponent("fixture.txt")
    try writeNew(Data("public-test-fixture".utf8), to: file)
    let directoryMode = (try fm.attributesOfItem(atPath: scratch.path)[.posixPermissions] as? NSNumber)?.intValue
    let fileMode = (try fm.attributesOfItem(atPath: file.path)[.posixPermissions] as? NSNumber)?.intValue
    try require(directoryMode == 0o700 && fileMode == 0o600, "백업 권한 검증 실패")
    do { try writeNew(Data("replacement".utf8), to: file); throw SigningFailure(message: "기존 백업을 덮어썼습니다") } catch let error as SigningFailure { try require(error.message != "기존 백업을 덮어썼습니다", error.message) }
    try require(try String(contentsOf: file, encoding: .utf8) == "public-test-fixture", "기존 백업 내용이 변경됐습니다")
    print("PASS: signing policy, exact CN/fingerprints, argument rejection, random entropy length, private permissions, no overwrite (키체인·키 생성 없음)")
}

/// 사용자 요청 명령만 실행하며 실패에 비밀 데이터나 원시 오류 객체를 포함하지 않는다.
func main() throws -> Int32 {
    let arguments = try parseArguments(Array(CommandLine.arguments.dropFirst()))
    umask(0o077)
    if arguments.command == "help" {
        print("사용법: signing-identity.swift create|status|export|import|verify-backup [--json] [--keychain 경로] [--bundle 백업폴더]\n검증: signing-identity.swift self-test")
        return 0
    }
    if arguments.command == "self-test" { try selfTest(); return 0 }
    switch arguments.command {
    case "status":
        let (status, _) = try statusOf(arguments.keychain)
        if arguments.json { FileHandle.standardOutput.write(try publicJSON(status)) }
        else { print("mGit 서명: \(status.status)\nSHA-1: \(status.sha1 ?? "미등록")\n키체인: \(status.keychain)") }
        return status.status == "ready" ? 0 : 1
    case "create":
        let bundle = try createIdentity(arguments)
        print(bundle.map { "mGit identity 준비 완료. 비공개 백업 폴더: \($0.path)" } ?? "기존 mGit identity가 준비되어 있습니다")
    case "export": print("mGit 비공개 백업 완료: \(try exportIdentity(arguments).path)")
    case "verify-backup": try verifyBackup(arguments)
    case "import":
        _ = try installBundle(arguments.bundle!, keychainPath: arguments.keychain)
        print("mGit identity 복원 완료. 다른 인증서는 변경하지 않았습니다")
    default: throw SigningFailure(message: "지원하지 않는 명령입니다")
    }
    return 0
}

do { exit(try main()) }
catch let failure as SigningFailure { FileHandle.standardError.write(Data(("오류: " + failure.message + "\n").utf8)); exit(1) }
catch { FileHandle.standardError.write(Data("오류: 서명 자료를 처리하지 못했습니다. 파일 형식·접근 권한을 확인하세요. 비밀 값은 기록하지 않았습니다.\n".utf8)); exit(1) }
