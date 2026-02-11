# Plugin Registry

A lightweight TypeScript plugin system for managing and loading plugins at runtime. Supports plugin lifecycle hooks, dependency resolution between plugins, and YAML-based configuration.

## Architecture

The registry uses a base plugin class that all plugins extend. Each plugin declares its dependencies and lifecycle methods (init, start, stop). The registry resolves load order based on declared dependencies.

## Configuration

Plugin configuration is managed through YAML config files with JSON Schema validation. The schema ensures plugins provide required metadata before registration.

## Scripts

Database migration tooling is included for managing plugin metadata storage. Migrations run from the project root and support up/down operations.

## Getting Started

1. Install dependencies: `npm install`
2. Define your plugin by extending the base class in `src/plugins/`
3. Register it in the configuration
4. Run the registry
