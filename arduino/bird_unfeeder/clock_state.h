#pragma once

#include <Arduino.h>
#include <ArduinoJson.h>
#include <string>
#include "wifi_util.h"

bool anyone_home() {
  String clock_state_str = get("https://internal.tinkerdeck.com/clock_state");
  if (clock_state_str == "") {
    Serial.println("Clock state fetch failed.");
    return false;
  }
  JsonDocument state_json = DynamicJsonDocument(clock_state_str.length());
  DeserializationError error = deserializeJson(state_json, clock_state_str);

  if (error) {
   Serial.print(F("deserializeJson() failed: "));
   Serial.println(error.f_str());
   return false;
  }

  for (JsonPair kv : state_json.as<JsonObject>()) {
    const char* location = kv.value().as<const char*>();
    if (std::string(location) == "Home") {
      return true;
    }
  }
  return false;
}