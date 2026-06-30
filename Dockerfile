FROM grafana/k6:latest

WORKDIR /app

# Copy the K6 script and default custom functions into the image.
# Override custom_functions.js at runtime by mounting your own file:
#   -v $(pwd)/custom_functions.js:/app/custom_functions.js
COPY stress_test.js       /app/stress_test.js
COPY custom_functions.js  /app/custom_functions.js

# Template files are NOT bundled — mount them at runtime:
#   -v $(pwd)/template.json:/app/template.json
# or for multiple templates:
#   -v $(pwd)/templates:/app/templates

ENTRYPOINT ["k6"]
