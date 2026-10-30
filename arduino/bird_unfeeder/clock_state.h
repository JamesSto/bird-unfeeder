#pragma once

#include <Arduino.h>
#include <ArduinoJson.h>
#include <string>
#include <optional>
#include "wifi_util.h"
#include "telemetry.h"

std::optional<bool> anyone_home() {
  String clock_state_str = get("https://internal.tinkerdeck.com/clock_state");
  if (clock_state_str == "") {
    addTelemetryEvent(TelemetryEvent::CLOCK_STATE_FETCH_FAILURE, "get failed");
    return std::nullopt;
  }
  JsonDocument state_json = DynamicJsonDocument(clock_state_str.length());
  DeserializationError error = deserializeJson(state_json, clock_state_str);

  if (error) {
   addTelemetryEvent(TelemetryEvent::CLOCK_STATE_FETCH_FAILURE, error.c_str());
   Serial.println(error.f_str());
   return std::nullopt;
  }

  for (JsonPair kv : state_json.as<JsonObject>()) {
    const char* location = kv.value().as<const char*>();
    if (std::string(location) == "Home") {
      return true;
    }
  }
  return false;
}