// Phase 1 cleartext is restricted to simulator/emulator loopback, including Metro.
const {
  withAndroidManifest,
  withMainApplication,
  withDangerousMod,
} = require('expo/config-plugins');
const { mkdirSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
module.exports = function withLoopbackNetwork(config) {
  config = withMainApplication(config, (mod) => {
    if (mod.modResults.language !== 'kt')
      throw new Error('Pocket requires Kotlin MainApplication');
    const marker = '// Pocket: never redirect WebSocket tickets';
    if (!mod.modResults.contents.includes(marker)) {
      if (!mod.modResults.contents.includes('super.onCreate()'))
        throw new Error('Expected MainApplication initialization');
      mod.modResults.contents = mod.modResults.contents.replace(
        'super.onCreate()',
        `super.onCreate()
    ${marker}
    com.facebook.react.modules.network.OkHttpClientProvider.setOkHttpClientFactory(
      com.facebook.react.modules.network.OkHttpClientFactory {
        com.facebook.react.modules.network.OkHttpClientProvider.createClientBuilder()
          .addInterceptor { chain ->
            val original = chain.request()
            val body = original.body
            val once = if (body == null) original else original.newBuilder().method(original.method,
              object : okhttp3.RequestBody() {
                override fun contentType() = body.contentType()
                override fun contentLength() = body.contentLength()
                override fun writeTo(sink: okio.BufferedSink) = body.writeTo(sink)
                override fun isOneShot() = true
              }).build()
            chain.proceed(once)
          }
          .retryOnConnectionFailure(false)
          .followRedirects(false)
          .followSslRedirects(false)
          .build()
      }
    )
    com.facebook.react.modules.websocket.WebSocketModule.setCustomClientBuilder(
      com.facebook.react.modules.network.CustomClientBuilder { builder ->
        builder.retryOnConnectionFailure(false).followRedirects(false).followSslRedirects(false)
      }
    )`,
      );
    }
    return mod;
  });
  config = withAndroidManifest(config, (mod) => {
    const features = mod.modResults.manifest['uses-feature'] ?? [];
    if (
      !features.some(
        (item) => item.$['android:name'] === 'android.hardware.camera',
      )
    )
      features.push({
        $: {
          'android:name': 'android.hardware.camera',
          'android:required': 'false',
        },
      });
    mod.modResults.manifest['uses-feature'] = features;
    const application = mod.modResults.manifest.application[0];
    application.$['android:networkSecurityConfig'] =
      '@xml/pocket_network_security';
    application.$['android:allowBackup'] = 'false';
    application.$['android:fullBackupContent'] = 'false';
    application.$['android:dataExtractionRules'] = '@xml/pocket_backup_rules';
    // RN 0.88 handles font-scale configuration changes and requests a Fabric
    // relayout. Keep one activity/router instead of recreating the dev-client
    // root (and losing its memory-only credential) when accessibility text grows.
    const activity = application.activity.find(
      (item) => item.$['android:name'] === '.MainActivity',
    );
    if (!activity) throw new Error('Expected Expo MainActivity');
    const changes = new Set(
      (activity.$['android:configChanges'] ?? '').split('|').filter(Boolean),
    );
    changes.add('fontScale');
    activity.$['android:configChanges'] = [...changes].join('|');
    return mod;
  });
  return withDangerousMod(config, [
    'android',
    async (mod) => {
      const directory = join(
        mod.modRequest.platformProjectRoot,
        'app/src/main/res/xml',
      );
      mkdirSync(directory, { recursive: true });
      // Android 12+ device transfers can ignore allowBackup on some devices.
      // Explicitly exclude all app storage from both transfer and cloud backup.
      const excludes = [
        'root',
        'file',
        'database',
        'sharedpref',
        'external',
        'device_root',
        'device_file',
        'device_database',
        'device_sharedpref',
      ]
        .map((domain) => `    <exclude domain="${domain}" path="." />`)
        .join('\n');
      writeFileSync(
        join(directory, 'pocket_backup_rules.xml'),
        `<?xml version="1.0" encoding="utf-8"?>\n<data-extraction-rules>\n  <cloud-backup>\n${excludes}\n  </cloud-backup>\n  <device-transfer>\n${excludes}\n  </device-transfer>\n</data-extraction-rules>\n`,
      );
      writeFileSync(
        join(directory, 'pocket_network_security.xml'),
        `<?xml version="1.0" encoding="utf-8"?>
<network-security-config>
  <base-config cleartextTrafficPermitted="false">
    <trust-anchors><certificates src="system" /><certificates src="user" /></trust-anchors>
  </base-config>
  <domain-config cleartextTrafficPermitted="true">
    <domain includeSubdomains="false">127.0.0.1</domain>
    <domain includeSubdomains="false">localhost</domain>
  </domain-config>
</network-security-config>
`,
      );
      return mod;
    },
  ]);
};
