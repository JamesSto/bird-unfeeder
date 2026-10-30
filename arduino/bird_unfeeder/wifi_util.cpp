#include "wifi_util.h"

#include <Arduino.h>
#include <WiFi.h>
#include <HTTPClient.h>
#include <NetworkClientSecure.h>

#include "telemetry.h"
#include "secrets.h"

constexpr int WIFI_CONNECTION_TIMEOUT_MS = 30 * 1000;

bool setClock() {
  configTime(0, 0, "pool.ntp.org");

  Serial.print(F("Waiting for NTP time sync: "));
  time_t nowSecs = time(nullptr);
  unsigned long start_time = millis();
  while (nowSecs < 8 * 3600 * 2 && millis() - start_time < WIFI_CONNECTION_TIMEOUT_MS) {
    delay(500);
    Serial.print(F("."));
    yield();
    nowSecs = time(nullptr);
  }
  if (millis() - start_time > WIFI_CONNECTION_TIMEOUT_MS) {
    addTelemetryEvent(TelemetryEvent::CLOCK_SET_FAILED, "timeout");
    Serial.println("Failed to set clock");
    return false;
  }

  Serial.println();
  struct tm timeinfo;
  gmtime_r(&nowSecs, &timeinfo);
  Serial.print(F("Current time: "));
  char buf[26];
  Serial.print(asctime_r(&timeinfo, buf));
  addTelemetryEvent(TelemetryEvent::CLOCK_SET);
  return true;
}


bool setup_wifi() {
  addTelemetryEvent(TelemetryEvent::CONNECTING_TO_WIFI);
  Serial.println("Connecting to wifi...");
  WiFi.begin("Roger Is A Good Boy", "rogeristhebestboy");
  unsigned long start_time = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - start_time < WIFI_CONNECTION_TIMEOUT_MS) {
    delay(300);
  }
  if (millis() - start_time > WIFI_CONNECTION_TIMEOUT_MS) {
    addTelemetryEvent(TelemetryEvent::WIFI_CONNECTION_FAILED, "timeout");
    Serial.println("Failed to connect to WiFi");
    return false;
  }
  addTelemetryEvent(TelemetryEvent::WIFI_CONNECTED);
  Serial.println("Wifi Connected!");
  return setClock();
}

// Assumes wifi is set up
String get(String url) {
  NetworkClientSecure client;
  client.useBuiltinCACertBundle();
  String payload;

  HTTPClient https;
  https.addHeader("Content-Type", "application/json");
  https.setAuthorizationType("basic");
  https.setAuthorization(SERVER_USERNAME, SERVER_PASSWORD);
  https.begin(client, url);
  int httpCode = https.GET();
  if (httpCode == HTTP_CODE_OK) {
      payload = https.getString();
      Serial.println(payload);
  } else {
    Serial.printf("[HTTP] GET... failed, error: %s, code: %d\n", https.errorToString(httpCode).c_str(), httpCode);
  }
  https.end();

  return payload;
}

int post(String url, String payload) {
  NetworkClientSecure client;
  client.useBuiltinCACertBundle();

  HTTPClient https;
  https.begin(client, url);
  https.addHeader("Content-Type", "application/json");
  https.setAuthorizationType("basic");
  https.setAuthorization(SERVER_USERNAME, SERVER_PASSWORD);
  int httpsCode = https.POST(payload);

  https.end();
  if (httpsCode < 200 || httpsCode >= 300) {
    Serial.printf("Post failed to %s, error code %d\n", url.c_str(), httpsCode);
  } else {
    Serial.printf("Post success to %s\n", url.c_str());
  }
  return httpsCode;
}