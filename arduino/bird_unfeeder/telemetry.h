#pragma once

#include <ArduinoJson.h>
#include <vector>
#include "constants.h"

enum class TelemetryEvent {
  WOKE_UP,
  CONNECTING_TO_WIFI,
  CLOCK_SET_FAILED,
  CLOCK_SET,
  WIFI_CONNECTED,
  WIFI_CONNECTION_FAILED,
  FOUND_CLOCK_STATE_HOME,
  FOUND_CLOCK_STATE_AWAY,
  WEIGHT_NOT_AT_TOP_WHEN_LOWERING,
  WEIGHT_ALREADY_AT_TOP_WHEN_RAISING,
  STARTING_LOWER_WEIGHT,
  STARTING_RAISE_WEIGHT,
  FINISHED_LOWER_WEIGHT,
  FINISHED_RAISE_WEIGHT,
  RAISE_WEIGHT_FAILURE,
  ENTERING_SLEEP
};

extern std::vector<JsonDocument> telemetry_messages;

void addTelemetryEvent(TelemetryEvent event);

String getTelemetryPayload();