// One-shot certificate issuance using the Windows .NET Framework. Keys remain
// ephemeral; only public certificates return through stdout. No store is opened.
using System;
using System.Collections.Generic;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using System.Web.Script.Serialization;

public static class CCDXPredictionCertificate {
  static byte[] Decode(Dictionary<string, object> key, string name, int size = 0) {
    string value = ((string)key[name]).Replace('-', '+').Replace('_', '/');
    var bytes = Convert.FromBase64String(value.PadRight((value.Length + 3) / 4 * 4, '='));
    if (size == 0 || bytes.Length == size) return bytes;
    if (bytes.Length > size) throw new InvalidOperationException("Invalid RSA component length");
    var padded = new byte[size]; Buffer.BlockCopy(bytes, 0, padded, size - bytes.Length, bytes.Length); return padded;
  }
  static void Import(RSACng rsa, Dictionary<string, object> key) {
    var modulus = Decode(key, "n"); var half = modulus.Length / 2;
    rsa.ImportParameters(new RSAParameters { Modulus = modulus, Exponent = Decode(key, "e"),
      D = Decode(key, "d", modulus.Length), P = Decode(key, "p", half), Q = Decode(key, "q", half),
      DP = Decode(key, "dp", half), DQ = Decode(key, "dq", half), InverseQ = Decode(key, "qi", half) });
    if (!rsa.Key.IsEphemeral) throw new InvalidOperationException("An ephemeral key is required");
  }
  static CertificateRequest Request(string name, RSA key, bool ca) {
    var request = new CertificateRequest(name, key, HashAlgorithmName.SHA256, RSASignaturePadding.Pkcs1);
    request.CertificateExtensions.Add(new X509BasicConstraintsExtension(ca, ca, 0, true));
    request.CertificateExtensions.Add(new X509KeyUsageExtension(ca
      ? X509KeyUsageFlags.KeyCertSign | X509KeyUsageFlags.DigitalSignature
      : X509KeyUsageFlags.DigitalSignature | X509KeyUsageFlags.KeyEncipherment, true));
    var usages = new OidCollection(); usages.Add(new Oid("1.3.6.1.5.5.7.3.1"));
    request.CertificateExtensions.Add(new X509EnhancedKeyUsageExtension(usages, false));
    var names = new SubjectAlternativeNameBuilder();
    names.AddDnsName("chatgpt.com"); names.AddDnsName("ab.chatgpt.com");
    request.CertificateExtensions.Add(names.Build(false));
    if (ca) {
      // DER NameConstraints: permitted DNS chatgpt.com, matching the existing CA.
      request.CertificateExtensions.Add(new X509Extension("2.5.29.30", new byte[] {
        0x30, 0x11, 0xa0, 0x0f, 0x30, 0x0d, 0x82, 0x0b,
        0x63, 0x68, 0x61, 0x74, 0x67, 0x70, 0x74, 0x2e, 0x63, 0x6f, 0x6d }, true));
    }
    return request;
  }
  public static void Run() {
    var json = new JavaScriptSerializer { MaxJsonLength = 16 * 1024 };
    var input = json.Deserialize<Dictionary<string, object>>(Console.In.ReadToEnd());
    using (var caKey = new RSACng())
    using (var leafKey = new RSACng())
    using (var random = RandomNumberGenerator.Create()) {
      Import(caKey, (Dictionary<string, object>)input["ca"]);
      Import(leafKey, (Dictionary<string, object>)input["leaf"]);
      var now = DateTimeOffset.FromUnixTimeSeconds(DateTimeOffset.UtcNow.ToUnixTimeSeconds());
      var before = now.AddMinutes(-5); var after = now.AddDays(90);
      var serial = new byte[16]; random.GetBytes(serial); serial[0] = (byte)((serial[0] & 0x7f) | 1);
      using (var ca = Request("CN=CCDX native prediction local bridge", caKey, true).CreateSelfSigned(before, after))
      using (var leaf = Request("CN=CCDX local prediction bridge", leafKey, false).Create(ca, before, after, serial)) {
        Console.Out.WriteLine(json.Serialize(new { ca = Convert.ToBase64String(ca.RawData), cert = Convert.ToBase64String(leaf.RawData) }));
      }
    }
  }
}
