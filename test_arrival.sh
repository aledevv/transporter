#!/bin/bash

# 1. Upload a test file (simple)
echo "Uploading file..."
# Use 127.0.0.1 and verbose to debug connection
curl -s -v -X POST -F "file=@test_simple.xlsx" http://127.0.0.1:5002/api/upload > upload_response.json 2> curl_log.txt
TASK_ID=$(cat upload_response.json | jq -r '.task_id')

if [ -z "$TASK_ID" ]; then
    echo "Error: Failed to get Task ID. Curl output:"
    curl -v -X POST -F "file=@test_simple.xlsx" http://127.0.0.1:5002/api/upload
    exit 1
fi

echo "Task ID: $TASK_ID"

# Wait for processing
sleep 10

# 2. Get the schools data from the task
echo "Getting schools data..."
SCHOOLS_JSON=$(curl -s http://127.0.0.1:5002/api/status/$TASK_ID | jq '.result')

# 3. Optimize with Arrival Mode (Target 08:30)
echo "Optimizing (Arrival Mode 08:30)..."
curl -s -v -X POST http://127.0.0.1:5002/api/optimize \
  -H "Content-Type: application/json" \
  -d "{
    \"schools\": $SCHOOLS_JSON,
    \"destination\": \"Piazza Dante, Trento\",
    \"capacity\": 50,
    \"time_mode\": \"arrival\",
    \"start_time\": \"08:30\"
  }" > result_arrival.json

# 4. Check results
echo "Checking results..."
# Extract the arrival time of the destination stop for the first route
ARRIVAL_TIME=$(cat result_arrival.json | jq -r '.routes[0].outbound.stops[-1].arrival_time')
echo "Route 0 Arrival Time: $ARRIVAL_TIME"

if [[ "$ARRIVAL_TIME" == "08:30" ]]; then
    echo "SUCCESS: Arrival time is 08:30"
else
    echo "FAILURE: Arrival time is $ARRIVAL_TIME (Expected 08:30)"
fi
