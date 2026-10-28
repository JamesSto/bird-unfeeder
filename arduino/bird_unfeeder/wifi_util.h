#pragma once

#include <Arduino.h>

#include <WiFi.h>

#include <HTTPClient.h>
#include <NetworkClientSecure.h>


bool setup_wifi();

String get(String url);

int post(String url, String payload);