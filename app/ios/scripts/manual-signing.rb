# Runs on the cloud Mac when the saved distribution certificate is used: tells the App target (only it, not the
# packages) to sign the Release build with that certificate and the given profile, instead of asking Apple for new ones.
#   ruby manual-signing.rb <team id> <profile name>
require 'xcodeproj'
team, profile = ARGV
project = Xcodeproj::Project.open(File.join(__dir__, '..', 'App', 'App.xcodeproj'))
target = project.targets.find { |t| t.name == 'App' }
target.build_configurations.each do |config|
  next unless config.name == 'Release'
  s = config.build_settings
  s['CODE_SIGN_STYLE'] = 'Manual'
  s['DEVELOPMENT_TEAM'] = team
  s['CODE_SIGN_IDENTITY'] = 'Apple Distribution'
  s['CODE_SIGN_IDENTITY[sdk=iphoneos*]'] = 'Apple Distribution'
  s['PROVISIONING_PROFILE_SPECIFIER'] = profile
end
project.save
puts 'Release build set to sign with the saved certificate'
