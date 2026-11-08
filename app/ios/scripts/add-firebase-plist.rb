# Runs on the cloud Mac before the iPhone build: puts GoogleService-Info.plist (Firebase, for notifications)
# into the app's resources. Safe to run again.
require 'xcodeproj'
project = Xcodeproj::Project.open(File.join(__dir__, '..', 'App', 'App.xcodeproj'))
target = project.targets.find { |t| t.name == 'App' }
group = project.main_group.find_subpath('App', false)
unless group.files.any? { |f| f.path == 'GoogleService-Info.plist' }
  ref = group.new_file('GoogleService-Info.plist')
  target.resources_build_phase.add_file_reference(ref)
  project.save
  puts 'GoogleService-Info.plist added'
else
  puts 'GoogleService-Info.plist already in the project'
end
