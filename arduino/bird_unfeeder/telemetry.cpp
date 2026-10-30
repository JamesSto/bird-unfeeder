#include "telemetry.h"

#include <ArduinoJson.h>
#include <WiFi.h>
#include "constants.h"
#include "esp_sleep.h"
#include "limit_switch.h"
#include "secrets.h"

std::vector<JsonDocument> telemetry_messages;

constexpr const char* to_string(TelemetryEvent e) {
  switch (e) {
    case TelemetryEvent::WOKE_UP: return "WOKE_UP";
    case TelemetryEvent::CONNECTING_TO_WIFI: return "CONNECTING_TO_WIFI";
    case TelemetryEvent::CLOCK_SET_FAILED: return "CLOCK_SET_FAILED";
    case TelemetryEvent::CLOCK_SET: return "CLOCK_SET";
    case TelemetryEvent::WIFI_CONNECTED: return "WIFI_CONNECTED";
    case TelemetryEvent::WIFI_CONNECTION_FAILED: return "WIFI_CONNECTION_FAILED";
    case TelemetryEvent::FOUND_CLOCK_STATE_HOME: return "FOUND_CLOCK_STATE_HOME";
    case TelemetryEvent::FOUND_CLOCK_STATE_AWAY: return "FOUND_CLOCK_STATE_AWAY";
    case TelemetryEvent::WEIGHT_NOT_AT_TOP_WHEN_LOWERING: return "WEIGHT_NOT_AT_TOP_WHEN_LOWERING";
    case TelemetryEvent::WEIGHT_ALREADY_AT_TOP_WHEN_RAISING: return "WEIGHT_ALREADY_AT_TOP_WHEN_RAISING";
    case TelemetryEvent::STARTING_LOWER_WEIGHT: return "STARTING_LOWER_WEIGHT";
    case TelemetryEvent::STARTING_RAISE_WEIGHT: return "STARTING_RAISE_WEIGHT";
    case TelemetryEvent::FINISHED_LOWER_WEIGHT: return "FINISHED_LOWER_WEIGHT";
    case TelemetryEvent::FINISHED_RAISE_WEIGHT: return "FINISHED_RAISE_WEIGHT";
    case TelemetryEvent::RAISE_WEIGHT_FAILURE: return "RAISE_WEIGHT_FAILURE";
    case TelemetryEvent::ENTERING_SLEEP: return "ENTERING_SLEEP";
  }
  return "UNKNOWN";
}

inline const char* reset_reason_string() {
  switch (esp_reset_reason()) {
    case ESP_RST_POWERON: return "power_on";
    case ESP_RST_EXT: return "reset_pin";
    case ESP_RST_SW: return "software";
    case ESP_RST_PANIC: return "crash";
    case ESP_RST_INT_WDT:
    case ESP_RST_TASK_WDT:
    case ESP_RST_WDT: return "watchdog";
    case ESP_RST_DEEPSLEEP: return "deep_sleep";
    case ESP_RST_BROWNOUT: return "brownout";
    default: return "other";
  }
}

inline const char* wakeup_cause_string() {
  switch (esp_sleep_get_wakeup_cause()) {
    case ESP_SLEEP_WAKEUP_TIMER: return "timer";
    case ESP_SLEEP_WAKEUP_UNDEFINED: return "not_from_sleep";
    default: return "other";
  }
}

// Averages several readings; the first one after power-up is often off, so it's discarded.
inline uint32_t read_battery_adc_mv() {
  analogReadMilliVolts(BATTERY_ADC_PIN);
  uint32_t sum = 0;
  constexpr int kSamples = 16;
  for (int i = 0; i < kSamples; ++i) sum += analogReadMilliVolts(BATTERY_ADC_PIN);
  return sum / kSamples;
}

void addTelemetryEvent(TelemetryEvent event) {
  JsonDocument doc;
  doc["event"] = to_string(event);

  // Every event
  time_t now = time(nullptr);
  doc["unix_time"] = static_cast<long long>(now);
  doc["clock_valid"] = now > 1700000000;  // false if NTP never synced (clock near 1970)
  doc["uptime_ms"] = millis();
  doc["limit_switch_pressed"] = limit_switch_pressed();

  // Wake-up diagnostics
  if (event == TelemetryEvent::WOKE_UP) {
    uint32_t adc_mv = read_battery_adc_mv();
    doc["battery_adc_mv"] = adc_mv;      // raw reading at the pin
    doc["battery_mv_est"] = adc_mv * 2;  // ASSUMES a 1:1 divider; verify with a multimeter
    doc["reset_reason"] = reset_reason_string();
    doc["wakeup_cause"] = wakeup_cause_string();
    doc["wifi_rssi"] = WiFi.RSSI();
    doc["wifi_channel"] = WiFi.channel();
    doc["free_heap"] = ESP.getFreeHeap();
    doc["min_free_heap"] = ESP.getMinFreeHeap();
    doc["build"] = __DATE__ " " __TIME__;
  }

  telemetry_messages.push_back(doc);
  serializeJson(doc, Serial);
  Serial.println("");
}

String getTelemetryPayload() {
  JsonDocument messages_doc;
  JsonArray message_arr = messages_doc.to<JsonArray>();
  for (JsonDocument j : telemetry_messages) {
    message_arr.add(j);
  }
  String post_body;
  serializeJson(messages_doc, post_body);
  return post_body;
}